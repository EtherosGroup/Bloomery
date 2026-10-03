/**
 * 按 Mojang 的运行时清单逐文件安装 Java
 *
 * 索引与逐文件清单各取一次，清单里的文件并发下载并逐个校验 sha1
 * 只取 downloads.raw，lzma 是压缩过的，要额外解码器
 * directory 建目录、link 还原符号链接、executable 还原可执行位
 * @author IsCibocaz
 * @since 1.9.0
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { parseJson } from "../config/read.ts";
import { AppError } from "../error/index.ts";
import {
    downloadAll,
    fetchBuffer,
    VERIFY_MISMATCH,
    type DownloadTask,
    type Progress,
    type TransferOptions,
} from "../infra/download.ts";
import { pathExists } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import {
    MOJANG_INDEX,
    mojangJavaPath,
    mojangPlatform,
    parseMojangManifest,
    pickMojangComponent,
    type MojangFile,
} from "./providers.ts";

const log = logger("java");

/** 分阶段的上报签名 */
export interface MojangProgress {
    (stage: string, done: number, total: number, bytes: boolean, existing: boolean): void;
}

export interface MojangInstallInput {
    readonly major: number;
    /** 安装位置：解出来的运行时放在它的下一层 */
    readonly root: string;
    readonly arch?: string | undefined;
    readonly options: TransferOptions;
    readonly dryRun?: boolean | undefined;
    readonly force?: boolean | undefined;
    readonly onProgress?: MojangProgress | undefined;
    /** 索引地址，默认 Mojang 官方 */
    readonly index?: string | undefined;
}

export interface MojangInstallReport {
    readonly provider: "mojang";
    /** 组件名，例如 java-runtime-delta */
    readonly component: string;
    readonly version: string;
    readonly platform: string;
    /** 组件那份清单的地址 */
    readonly url: string;
    /** 安装根，例如 /opt/java/java-runtime-delta-21.0.7 */
    readonly root: string;
    /** 可执行文件，登记进清单就用它 */
    readonly java: string;
    readonly files: number;
    readonly bytes: number;
    readonly directories: number;
    readonly links: number;
}

export async function installMojangRuntime(
    input: MojangInstallInput,
): Promise<MojangInstallReport> {
    const platform = mojangPlatform(process.platform, input.arch);
    if (platform === null) {
        throw new AppError("java", "JavaNotFound", {
            context: { detail: `mojang 清单没有 ${process.platform}/${input.arch} 的平台条目` },
        });
    }

    const index = input.index ?? MOJANG_INDEX;
    const component = pickMojangComponent(
        parseJson((await fetchBuffer(index, input.options)).toString("utf8"), index),
        platform,
        input.major,
        index,
    );
    if (component === null) {
        throw new AppError("java", "JavaNotFound", {
            context: {
                detail: `mojang 清单里没有主版本 ${input.major} 的运行时（平台 ${platform}）`,
            },
        });
    }

    const manifestBytes = await fetchBuffer(component.manifestUrl, input.options);
    if (component.manifestSha1 !== "") {
        const digest = createHash("sha1").update(manifestBytes).digest("hex");
        if (digest !== component.manifestSha1) {
            throw new AppError("java", "InstallBroken", {
                context: {
                    detail: `${component.manifestUrl} 校验不过`,
                    expected: component.manifestSha1,
                    actual: digest,
                },
            });
        }
    }

    const manifest = parseMojangManifest(
        parseJson(manifestBytes.toString("utf8"), component.manifestUrl),
        component.manifestUrl,
    );
    const downloads = manifest.filter((entry) => entry.type === "file" && entry.url !== null);
    if (downloads.length === 0) {
        throw new AppError("java", "InstallBroken", {
            context: { detail: `${component.name} 的清单里没有可下载的文件` },
        });
    }
    const root = join(input.root, `${component.name}-${component.version}`);
    const report: MojangInstallReport = {
        provider: "mojang",
        component: component.name,
        version: component.version,
        platform,
        url: component.manifestUrl,
        root,
        java: join(root, mojangJavaPath(manifest, process.platform)),
        files: downloads.length,
        bytes: downloads.reduce((sum, entry) => sum + (entry.size ?? 0), 0),
        directories: manifest.filter((entry) => entry.type === "directory").length,
        links: manifest.filter((entry) => entry.type === "link").length,
    };

    log.info("mojang %s %s → %s", component.name, component.version, report.root);
    if (input.dryRun === true) {
        return report;
    }
    if (input.force !== true && (await pathExists(report.root))) {
        throw new AppError("java", "JavaDuplicate", { context: { detail: report.root } });
    }

    await unpack(manifest, report.root, input);
    return report;
}

// 建目录、还原链接，再并发下文件、补可执行位
async function unpack(
    manifest: readonly MojangFile[],
    root: string,
    input: MojangInstallInput,
): Promise<void> {
    await rm(root, { recursive: true, force: true });
    await mkdir(root, { recursive: true });

    for (const entry of manifest) {
        const target = join(root, entry.path);
        if (entry.type === "directory") {
            await mkdir(target, { recursive: true });
            continue;
        }
        if (entry.type === "link" && entry.target !== null) {
            await mkdir(dirname(target), { recursive: true });
            // Windows 建符号链接要权限，失败的链接只影响 legal 下的许可证副本
            await symlink(entry.target, target).catch((error: unknown) => {
                log.debug("符号链接 %s 建失败：%s", target, message(error));
            });
        }
    }

    const tasks: DownloadTask[] = [];
    for (const entry of manifest) {
        if (entry.type !== "file" || entry.url === null) {
            continue;
        }
        tasks.push({
            url: entry.url,
            target: join(root, entry.path),
            sha1: entry.sha1,
            size: entry.size,
        });
    }
    const report = await downloadAll(tasks, input.options, stage(input.onProgress));
    const failure = report.failures[0];
    if (failure !== undefined) {
        throw new AppError(
            "java",
            failure.error.startsWith(VERIFY_MISMATCH) ? "InstallBroken" : "DownloadFailed",
            { context: { detail: failure.error } },
        );
    }

    for (const entry of manifest) {
        if (entry.type === "file" && entry.executable) {
            await chmod(join(root, entry.path), 0o755);
        }
    }
    log.info(
        "写入 %d 个文件、%d 个目录、%d 个链接，%d 字节",
        report.downloaded + report.skipped,
        manifest.filter((entry) => entry.type === "directory").length,
        manifest.filter((entry) => entry.type === "link").length,
        report.bytes,
    );
}

// 一个阶段的下载事件，阶段名固定
function stage(onProgress: MojangProgress | undefined): Progress | undefined {
    return onProgress === undefined
        ? undefined
        : (done, total, bytes, _target, existing) =>
              onProgress("文件", done, total, bytes, existing);
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
