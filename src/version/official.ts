/**
 * 官方安装器
 *
 * forge 与 neoforge 没有 profile json，只能下官方安装器跑一次
 * 它自己会把库与补丁装进文件夹，这里只负责下载、执行、找出它写了哪个版本目录
 * @author IsCibocaz
 * @since 1.6.0
 */

import { spawn } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "../error/index.ts";
import { downloadOne, type TransferOptions } from "../infra/download.ts";
import { pathExists, writeAtomic } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import { installerUrlOf, type LoaderName } from "./loader.ts";

const log = logger("official");

// 两家安装器的参数名不同：forge 用驼峰，neoforge 的 fork 两个都认
const INSTALL_FLAGS: Partial<Record<LoaderName, string>> = {
    forge: "--installClient",
    neoforge: "--install-client",
};

/** 安装器下载的空闲上限，宿主不吐字节时不至于过早失败 */
const INSTALLER_TIMEOUT_MS = 60_000;

/** 安装器输出先留这么多行，报错时再挑有效行 */
const TAIL_LINES = 200;

/** 这些是逐个库的噪声，报错时要滤掉 */
const NOISY =
    /Considering library|File .* exists|Checksum valid|^Downloading|^Extracting|^Considering/i;

/** 这些才说明出了什么事 */
const INTERESTING =
    /(Exception|Caused by|error|Error|failed|Failed|cannot|Cannot|unable|Unable|refus|refused|denied|timeout|timed out|not found|No such)/;

export interface OfficialInstallInput {
    readonly name: LoaderName;
    readonly game: string;
    readonly loaderVersion: string;
    readonly folderPath: string;
    /** 挑好的 java 可执行文件 */
    readonly java: string;
    /** 过程提示；--json 时调用方不给 */
    readonly onLine?: ((text: string) => void) | undefined;
    readonly options: TransferOptions;
}

export interface OfficialInstallReport {
    readonly loader: LoaderName;
    readonly loaderVersion: string;
    /** 安装器写出的版本目录名，实例继承它 */
    readonly versionDirectory: string;
    readonly java: string;
    /** 安装器输出的末尾几行，出错时给用户看 */
    readonly tail: readonly string[];
}

export async function installWithOfficial(
    input: OfficialInstallInput,
): Promise<OfficialInstallReport> {
    const url = installerUrlOf(input.name, input.game, input.loaderVersion);
    if (url === null) {
        throw new AppError("install", "NotImplemented", {
            context: { detail: `${input.name} 没有官方安装器地址` },
        });
    }

    const workDirectory = join(input.folderPath, ".bloomery");
    await mkdir(workDirectory, { recursive: true });
    const installer = join(workDirectory, `${input.name}-${input.loaderVersion}-installer.jar`);

    log.info("下安装器 %s", url);
    try {
        await downloadOne(
            { url, target: installer, sha1: null, size: null },
            // 安装器十来 MB，宿主可能长时间不吐字节，空闲上限放宽
            {
                ...input.options,
                timeoutMs: Math.max(input.options.timeoutMs, INSTALLER_TIMEOUT_MS),
            },
        );
    } catch (error) {
        throw new AppError("install", "DownloadFailed", {
            context: {
                detail: `${input.name} 安装器`,
                url,
                cause: error instanceof Error ? error.message : String(error),
            },
        });
    }

    // 安装器会检查启动器档案，缺了就写一个最小的；官方启动器之后会覆盖它
    if (await ensureLauncherProfile(input.folderPath)) {
        log.info("补 launcher_profiles.json");
    }

    const before = await versionsOf(input.folderPath);
    const tail: string[] = [];
    const flag = INSTALL_FLAGS[input.name] ?? "--install-client";
    try {
        await attempt(input, installer, flag, tail);
    } catch (error) {
        // 参数名认不出就换另一种写法再试一次
        if (!tail.some((line) => line.includes("UnrecognizedOption"))) {
            throw officialError(input, error, tail);
        }
        const other = flag === "--installClient" ? "--install-client" : "--installClient";
        log.info("%s 不认 %s，换 %s 再试", input.name, flag, other);
        try {
            await attempt(input, installer, other, tail);
        } catch (retry) {
            throw officialError(input, retry, tail);
        }
    } finally {
        await rm(installer, { force: true }).catch(() => undefined);
    }

    const after = await versionsOf(input.folderPath);
    const added = after.filter((item) => !before.includes(item));
    // 安装器认为已装好时不写新目录，这时用已有的那份
    // forge 的目录名是 <游戏版本>-forge-<版本>，用后缀匹配才盖得住两种写法
    const short = input.loaderVersion.startsWith(`${input.game}-`)
        ? input.loaderVersion.slice(input.game.length + 1)
        : input.loaderVersion;
    const match = (item: string): boolean =>
        item.includes(input.loaderVersion) || item.endsWith(short);
    const versionDirectory = added.find(match) ?? added[0] ?? after.find(match);
    if (versionDirectory === undefined) {
        throw new AppError("install", "InstallBroken", {
            context: {
                detail: "安装器未产出新版本目录",
                tail: usefulLines(tail, input.folderPath),
            },
        });
    }

    log.info("安装器写出 %s", versionDirectory);
    return {
        loader: input.name,
        loaderVersion: input.loaderVersion,
        versionDirectory,
        java: input.java,
        tail,
    };
}

// 先去噪声再挑真正的错；挑不到就把去噪后的行都给出来，末尾附上完整日志位置
export function usefulLines(lines: readonly string[], folderPath: string): string {
    const quiet = lines.filter((line) => !NOISY.test(line));
    const hits = quiet.filter((line) => INTERESTING.test(line));
    const picked = (hits.length > 0 ? hits : quiet).slice(-6);
    return [...picked, `完整输出见 ${join(folderPath, "installer.log")}`].join(" / ");
}

function proxyArgs(proxy: string | null): string[] {
    if (proxy === null || proxy === "") {
        return [];
    }
    try {
        const url = new URL(proxy);
        const host = url.hostname;
        const port = url.port === "" ? (url.protocol === "https:" ? "443" : "80") : url.port;
        return [
            `-Dhttp.proxyHost=${host}`,
            `-Dhttp.proxyPort=${port}`,
            `-Dhttps.proxyHost=${host}`,
            `-Dhttps.proxyPort=${port}`,
        ];
    } catch {
        return [];
    }
}

// 返回是否新写了
async function ensureLauncherProfile(folderPath: string): Promise<boolean> {
    const file = join(folderPath, "launcher_profiles.json");
    if (await pathExists(file)) {
        return false;
    }
    const minimal = {
        profiles: {},
        selectedProfile: "",
        clientToken: "",
        authenticationDatabase: {},
        launcherVersion: { name: "", format: 0 },
        version: 3,
    };
    await writeAtomic(file, `${JSON.stringify(minimal, null, 4)}\n`);
    return true;
}

// 安装器是 java 程序，不认 http_proxy 环境变量，代理只能从 -D 传进去
function attempt(
    input: OfficialInstallInput,
    installer: string,
    flag: string,
    tail: string[],
): Promise<void> {
    const args = [
        ...proxyArgs(input.options.proxy ?? null),
        "-jar",
        installer,
        flag,
        input.folderPath,
    ];
    // 安装器要跑几分钟，输出实时透传
    input.onLine?.(`运行 ${input.name} 官方安装器`);
    return run(input.java, args, input.folderPath, (line) => {
        tail.push(line);
        if (tail.length > TAIL_LINES) {
            tail.shift();
        }
        input.onLine?.(`  ${line}`);
    });
}

function officialError(
    input: OfficialInstallInput,
    error: unknown,
    tail: readonly string[],
): AppError {
    // 安装器退出码非 0：重试往往没用（Java 版本不符、安装器本身报错），所以不标可重试
    return new AppError("install", "LoaderInstallFailed", {
        context: {
            detail: `${input.name} 官方安装器执行失败`,
            java: input.java,
            cause: error instanceof Error ? error.message : String(error),
            tail: usefulLines(tail, input.folderPath),
        },
    });
}

async function versionsOf(folderPath: string): Promise<string[]> {
    try {
        const entries = await readdir(join(folderPath, "versions"), { withFileTypes: true });
        return entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();
    } catch {
        return [];
    }
}

// 安装器的输出是给人看的，这里只收行，退出码非 0 就抛
function run(
    java: string,
    args: readonly string[],
    cwd: string,
    onLine: (line: string) => void,
): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(java, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
        const feed = (chunk: Buffer): void => {
            for (const line of chunk.toString("utf8").split(/\r?\n/)) {
                if (line.trim() !== "") {
                    onLine(line.trim());
                }
            }
        };
        child.stdout.on("data", feed);
        child.stderr.on("data", feed);
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`安装器退出码 ${code ?? "未知"}`));
        });
    });
}
