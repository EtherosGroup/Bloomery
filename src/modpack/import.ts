/**
 * 整合包导入
 *
 * 先按包里的游戏版本与加载器建实例，再把清单里的文件下到各自落点，最后摊平 overrides/
 * 清单里没有下载地址的文件只记警告，不拦整包
 * @author IsCibocaz
 * @since 1.3.0
 */

import { join } from "node:path";

import type { DownloadSetting, Network } from "../config/types.ts";
import { AppError } from "../error/index.ts";
import { downloadAll, type DownloadTask, type TransferOptions } from "../infra/download.ts";
import { sourcesOf } from "../infra/source.ts";
import { extractZip } from "../infra/zip.ts";
import { logger } from "../output/index.ts";
import {
    installVersion,
    type InstallProgress,
    type InstallReport,
    type LoaderName,
} from "../version/index.ts";
import { readMrpack, type Mrpack, type MrpackFile } from "./mrpack.ts";

const log = logger("modpack");

const OVERRIDE_PREFIX = /^(client-)?overrides\//;

export interface ModpackImportInput {
    readonly archive: string;
    /** 游戏文件夹 */
    readonly folderPath: string;
    /** 实例名，省略按包名或文件名推 */
    readonly name?: string | undefined;
    readonly network: Network;
    readonly download: DownloadSetting;
    /** 只算不落盘 */
    readonly dryRun?: boolean | undefined;
    /** false 时跳过资源对象，只装游戏本体 */
    readonly assets?: boolean | undefined;
    /** 包里要 forge / neoforge 时官方安装器用的 java */
    readonly officialJava?: string | undefined;
    readonly onProgress?: InstallProgress | undefined;
}

export interface ModpackImportReport {
    readonly name: string;
    readonly pack: {
        readonly name: string | null;
        readonly versionId: string;
        readonly loader: { readonly name: LoaderName; readonly version: string } | null;
    };
    readonly version: { readonly name: string; readonly clientJar: boolean } | null;
    readonly files: {
        readonly total: number;
        readonly downloaded: number;
        readonly skipped: number;
        readonly bytes: number;
        readonly failures: readonly string[];
    };
    readonly overrides: number;
    readonly warnings: readonly string[];
}

export async function importModpack(input: ModpackImportInput): Promise<ModpackImportReport> {
    const pack = await readMrpack(input.archive);
    const name = input.name ?? nameOf(pack.name, input.archive);
    const versionsDirectory = join(input.folderPath, "versions");
    const instanceDirectory = join(versionsDirectory, name);
    const options = transferOf(input.network, input.download);
    const { tasks, warnings } = modpackTasks(pack, instanceDirectory);
    log.debug("%s：%d 个文件待下，%d 条警告", name, tasks.length, warnings.length);

    if (input.dryRun === true) {
        return {
            name,
            pack: packSummary(pack),
            version: null,
            files: { total: tasks.length, downloaded: 0, skipped: 0, bytes: 0, failures: [] },
            overrides: 0,
            warnings,
        };
    }

    // 版本目录名就是实例名，重名直接拒绝
    const installed: InstallReport = await installVersion({
        folderPath: input.folderPath,
        versionId: pack.versionId,
        name,
        loader: pack.loader,
        network: input.network,
        download: input.download,
        assets: input.assets !== false,
        officialJava: input.officialJava,
        onProgress: input.onProgress,
    });

    // 两个阶段的上报签名不同，下载阶段只在结束时汇总
    const report = await downloadAll(tasks, options);
    const overrides = await extractZip(input.archive, instanceDirectory, {
        keep: (entry) => OVERRIDE_PREFIX.test(entry),
        strip: (entry) => entry.replace(OVERRIDE_PREFIX, ""),
    });

    return {
        name,
        pack: packSummary(pack),
        version: { name: installed.name, clientJar: installed.clientJar },
        files: {
            total: tasks.length,
            downloaded: report.downloaded,
            skipped: report.skipped,
            bytes: report.bytes,
            failures: report.failures.map((failure) => failure.target),
        },
        overrides,
        warnings,
    };
}

// 清单里该下哪些文件、下到哪，纯计算便于测试
export function modpackTasks(
    pack: Mrpack,
    instanceDirectory: string,
): { tasks: DownloadTask[]; warnings: string[] } {
    const tasks: DownloadTask[] = [];
    const warnings: string[] = [];

    for (const file of pack.files) {
        if (!file.client) {
            continue;
        }
        if (file.url === null) {
            warnings.push(`${file.path} 没有下载地址，包作者可能只给了 CurseForge 的引用`);
            continue;
        }
        tasks.push({
            url: file.url,
            target: join(instanceDirectory, file.path),
            sha1: file.sha1,
            size: file.size,
        });
    }
    return { tasks, warnings };
}

function packSummary(pack: Mrpack): ModpackImportReport["pack"] {
    const loader =
        pack.loader === null
            ? null
            : { name: pack.loader.name, version: pack.loader.version ?? "latest" };
    return { name: pack.name, versionId: pack.versionId, loader };
}

// 实例名要能当目录名：非法字符换成短横线
function nameOf(packName: string | null, archive: string): string {
    const base =
        packName ??
        archive
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.mrpack$/i, "") ??
        "modpack";
    const safe = base
        .replace(/[\\/:*?"<>|\s]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^[-.]+|[-.]+$/g, "");
    if (safe === "") {
        throw new AppError("modpack", "UsageError", {
            context: { detail: `整合包名字推不出可用的实例名：${archive}` },
        });
    }
    return safe;
}

function transferOf(network: Network, download: DownloadSetting): TransferOptions {
    return {
        timeoutMs: network.timeoutMs,
        retries: network.retries,
        proxy: network.proxy ?? null,
        noProxy: network.noProxy,
        verify: download.verify,
        concurrency: network.concurrency,
        sources: sourcesOf(download),
    };
}
