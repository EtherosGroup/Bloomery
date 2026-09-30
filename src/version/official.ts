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

/** 安装器输出留这么多行给用户看 */
const TAIL_LINES = 12;

export interface OfficialInstallInput {
    readonly name: LoaderName;
    readonly game: string;
    readonly loaderVersion: string;
    readonly folderPath: string;
    /** 挑好的 java 可执行文件 */
    readonly java: string;
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
    await downloadOne({ url, target: installer, sha1: null, size: null }, input.options);

    // 安装器会检查启动器档案，缺了就写一个最小的；官方启动器之后会覆盖它
    if (await ensureLauncherProfile(input.folderPath)) {
        log.info("写了最小的 launcher_profiles.json，安装器要求目录里有它");
    }

    const before = await versionsOf(input.folderPath);
    const tail: string[] = [];
    try {
        // 安装器是 java 程序，不认 http_proxy 环境变量，代理只能从 -D 传进去
        const args = [
            ...proxyArgs(input.options.proxy ?? null),
            "-jar",
            installer,
            "--install-client",
            input.folderPath,
        ];
        await run(input.java, args, input.folderPath, (line) => {
            tail.push(line);
            if (tail.length > TAIL_LINES) {
                tail.shift();
            }
            log.debug("安装器：%s", line);
        });
    } catch (error) {
        throw new AppError("install", "DependencyMissing", {
            context: {
                detail: `${input.name} 的官方安装器没跑成`,
                java: input.java,
                cause: error instanceof Error ? error.message : String(error),
                tail: tail.join(" / "),
            },
        });
    } finally {
        await rm(installer, { force: true }).catch(() => undefined);
    }

    const added = (await versionsOf(input.folderPath)).filter((item) => !before.includes(item));
    const versionDirectory = added.find((item) => item.includes(input.loaderVersion)) ?? added[0];
    if (versionDirectory === undefined) {
        throw new AppError("install", "VersionBroken", {
            context: {
                detail: "安装器跑完了，但 versions 下没多出目录",
                tail: tail.join(" / "),
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
