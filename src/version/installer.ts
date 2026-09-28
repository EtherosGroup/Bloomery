/**
 * 安装一个版本
 *
 * 版本 json 不在就从 version_manifest_v2 取
 * 客户端 jar、库、natives、资源索引与对象逐个补齐；已存在的文件跳过，
 * 所以对别的启动器装好的目录来说，这一步实际是「补缺」
 * natives 按当前平台取，Linux 上补的就是 Linux 的 so，与 jar 是不是别人下的无关
 * @author IsCibocaz
 * @since 1.0.0
 */

import { copyFile, link, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DownloadSetting, Network } from "../config/types.ts";
import {
    allows,
    assetIndexFile,
    assetObjectFile,
    classifierMatches,
    extractNatives,
    isClasspathLibrary,
    libraryFile,
    libraryUrlPath,
    nativeClassifierOf,
    nativeJars,
    parseCoordinate,
    platformContext,
    readAssetIndex,
    type AssetIndex,
    type Coordinate,
    type RuleContext,
} from "../dependency/index.ts";
import { AppError } from "../error/index.ts";
import {
    downloadAll,
    fetchBuffer,
    type DownloadReport,
    type DownloadTask,
    type Progress,
    type TransferOptions,
} from "../infra/download.ts";
import { pathExists, writeAtomic } from "../infra/fs.ts";
import { sourcesOf } from "../infra/source.ts";
import { logger } from "../output/index.ts";
import { readDescriptor, type Descriptor, type DownloadEntry, type Library } from "./descriptor.ts";
import { fetchManifest, findVersion } from "./manifest.ts";

const log = logger("install");

const ASSET_ROOT = "https://resources.download.minecraft.net";

const EMPTY_REPORT: DownloadReport = { downloaded: 0, skipped: 0, bytes: 0, failures: [] };

export interface InstallProgress {
    (stage: string, done: number, total: number): void;
}

export interface InstallInput {
    readonly folderPath: string;
    readonly versionId: string;
    readonly network: Network;
    readonly download: DownloadSetting;
    /** false 时跳过资源对象，只装游戏本体 */
    readonly assets?: boolean;
    readonly onProgress?: InstallProgress;
}

export interface InstallReport {
    readonly versionId: string;
    readonly json: "present" | "fetched";
    readonly clientJar: boolean;
    readonly libraries: DownloadReport;
    readonly natives: {
        readonly jars: number;
        readonly files: number;
        readonly report: DownloadReport;
    };
    readonly assets: { readonly index: DownloadReport; readonly objects: DownloadReport } | null;
    readonly warnings: readonly string[];
}

export async function installVersion(input: InstallInput): Promise<InstallReport> {
    const warnings: string[] = [];
    const versionDir = join(input.folderPath, "versions", input.versionId);
    const jsonPath = join(versionDir, `${input.versionId}.json`);
    const librariesRoot = join(input.folderPath, "libraries");
    const assetsRoot = join(input.folderPath, "assets");

    const options: TransferOptions = {
        timeoutMs: input.network.timeoutMs,
        retries: input.network.retries,
        proxy: input.network.proxy ?? null,
        noProxy: input.network.noProxy,
        verify: input.download.verify,
        concurrency: input.network.concurrency,
        sources: sourcesOf(input.download),
    };

    let json: "present" | "fetched" = "present";
    if (!(await pathExists(jsonPath))) {
        await writeVersionJson(input.versionId, jsonPath, options);
        json = "fetched";
        log.info("取到版本 json %s", input.versionId);
    }

    const read = await readDescriptor(jsonPath, input.versionId);
    if (read.descriptor === null) {
        throw new AppError("install", "VersionBroken", {
            context: { detail: input.versionId, problem: read.problem ?? "" },
        });
    }
    const descriptor = read.descriptor;
    const context = platformContext();

    const clientJar = join(versionDir, `${input.versionId}.jar`);
    const client = await installClientJar(descriptor, clientJar, options, warnings);

    const { libraries: libraryTasks, natives: nativeTasks } = splitTasks(
        descriptor,
        context,
        librariesRoot,
    );
    const libraries = await downloadAll(libraryTasks, options, stage(input.onProgress, "库"));
    const nativeReport = await downloadAll(
        nativeTasks,
        options,
        stage(input.onProgress, "natives"),
    );

    const selection = await nativeJars({
        libraries: descriptor.libraries,
        context,
        librariesRoot,
    });
    const files = await extractNatives(selection.jars, join(versionDir, "natives"));

    const assets =
        input.assets === false
            ? null
            : await installAssets(descriptor, assetsRoot, options, warnings, input.onProgress);

    return {
        versionId: input.versionId,
        json,
        clientJar: client,
        libraries,
        natives: { jars: selection.jars.length, files, report: nativeReport },
        assets,
        warnings,
    };
}

/* ---------- 版本 json ---------- */

async function writeVersionJson(
    id: string,
    jsonPath: string,
    options: TransferOptions,
): Promise<void> {
    const manifest = await fetchManifest(options);
    const version = findVersion(manifest, id);
    if (version === undefined) {
        throw new AppError("install", "VersionNotFound", {
            context: { detail: id, latest: manifest.latest.release ?? "未知" },
        });
    }

    const buffer = await fetchBuffer(version.url, options);
    const text = buffer.toString("utf8");
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch (error) {
        throw new AppError("install", "VersionBroken", {
            cause: error,
            context: { detail: `${id} 的 json 解析失败` },
        });
    }
    await writeAtomic(jsonPath, `${JSON.stringify(value, null, 4)}\n`);
}

/* ---------- 客户端 jar ---------- */

async function installClientJar(
    descriptor: Descriptor,
    clientJar: string,
    options: TransferOptions,
    warnings: string[],
): Promise<boolean> {
    const entry = descriptor.downloads["client"];
    if (entry === undefined) {
        warnings.push("版本 json 里没有客户端 jar 的下载信息");
        return false;
    }
    if (await pathExists(clientJar)) {
        return true;
    }
    const report = await downloadAll(
        [{ url: entry.url, target: clientJar, sha1: entry.sha1, size: entry.size }],
        options,
    );
    if (report.failures.length > 0) {
        throw new AppError("install", "DependencyMissing", {
            context: { detail: `客户端 jar：${report.failures[0]?.error ?? ""}` },
        });
    }
    return true;
}

/* ---------- 库与 natives ---------- */

interface SplitTasks {
    readonly libraries: readonly DownloadTask[];
    readonly natives: readonly DownloadTask[];
}

function splitTasks(
    descriptor: Descriptor,
    context: RuleContext,
    librariesRoot: string,
): SplitTasks {
    const libraries: DownloadTask[] = [];
    const natives: DownloadTask[] = [];

    for (const library of descriptor.libraries) {
        if (!allows(library.rules, context)) {
            continue;
        }
        const coordinate = parseCoordinate(library.name);
        if (coordinate === undefined) {
            continue;
        }

        const classifier = nativeClassifierOf(library, context);
        if (classifier !== undefined) {
            const target = libraryFile(librariesRoot, { ...coordinate, classifier });
            const entry = library.downloads.classifiers[classifier] ?? library.downloads.artifact;
            const task = taskOf(entry, library, target, { ...coordinate, classifier });
            if (task !== null) {
                natives.push(task);
            }
            continue;
        }

        if (!isClasspathLibrary(library)) {
            continue;
        }
        if (coordinate.classifier !== null && !classifierMatches(coordinate.classifier, context)) {
            continue;
        }
        const task = taskOf(
            library.downloads.artifact,
            library,
            libraryFile(librariesRoot, coordinate),
            coordinate,
        );
        if (task !== null) {
            libraries.push(task);
        }
    }

    return { libraries, natives };
}

// 有条目就用条目里的地址与 sha1；没有就按库自带的仓库地址拼
function taskOf(
    entry: DownloadEntry | null,
    library: Library,
    target: string,
    coordinate: Coordinate,
): DownloadTask | null {
    if (entry !== null) {
        return {
            url: entry.url,
            target,
            sha1: entry.sha1 === "" ? null : entry.sha1,
            size: entry.size,
        };
    }
    const base = library.url;
    if (base === null || base === "") {
        return null;
    }
    return {
        url: `${base.replace(/\/+$/, "")}/${libraryUrlPath(coordinate)}`,
        target,
        sha1: null,
        size: null,
    };
}

/* ---------- 资源 ---------- */

async function installAssets(
    descriptor: Descriptor,
    assetsRoot: string,
    options: TransferOptions,
    warnings: string[],
    onProgress: InstallProgress | undefined,
): Promise<{ index: DownloadReport; objects: DownloadReport } | null> {
    const id = descriptor.assetIndex?.id ?? descriptor.assets;
    if (id === null || id === "") {
        warnings.push("版本 json 里没有资源索引信息");
        return null;
    }

    const indexPath = assetIndexFile(assetsRoot, id);
    let index: DownloadReport = EMPTY_REPORT;
    const indexUrl = descriptor.assetIndex?.url ?? null;
    if (indexUrl !== null) {
        index = await downloadAll(
            [
                {
                    url: indexUrl,
                    target: indexPath,
                    sha1: descriptor.assetIndex?.sha1 ?? null,
                    size: descriptor.assetIndex?.size ?? null,
                },
            ],
            options,
        );
    } else if (!(await pathExists(indexPath))) {
        warnings.push(`没有资源索引 ${id} 的地址，资源只能跳过`);
        return null;
    }

    const parsed = await readAssetIndex(assetsRoot, id);
    if (parsed === null) {
        warnings.push(`资源索引 ${id} 读不出来`);
        return null;
    }

    const objects = await downloadAll(
        objectTasks(assetsRoot, parsed),
        options,
        stage(onProgress, "资源"),
    );

    if (parsed.virtual) {
        const linked = await layoutVirtual(assetsRoot, parsed);
        log.info("索引 %s 是 virtual 的，另铺了 %d 个对象", id, linked);
    }
    if (parsed.mapToResources) {
        warnings.push(`索引 ${id} 要 map_to_resources，这一版还没处理`);
    }

    return { index, objects };
}

// 同一个哈希可能挂在多个名字下，按目标去重
function objectTasks(assetsRoot: string, index: AssetIndex): DownloadTask[] {
    const tasks: DownloadTask[] = [];
    const seen = new Set<string>();

    for (const object of Object.values(index.objects)) {
        const target = assetObjectFile(assetsRoot, object.hash);
        if (seen.has(target)) {
            continue;
        }
        seen.add(target);
        tasks.push({
            url: `${ASSET_ROOT}/${object.hash.slice(0, 2)}/${object.hash}`,
            target,
            sha1: object.hash,
            size: object.size,
        });
    }
    return tasks;
}

// 1.7 以前：对象要按原文件名另铺一份到 assets/virtual/<id>/
async function layoutVirtual(assetsRoot: string, index: AssetIndex): Promise<number> {
    const root = join(assetsRoot, "virtual", index.id);
    let linked = 0;

    for (const [name, object] of Object.entries(index.objects)) {
        const source = assetObjectFile(assetsRoot, object.hash);
        const destination = join(root, ...name.split("/"));
        if (await pathExists(destination)) {
            continue;
        }
        await mkdir(dirname(destination), { recursive: true });
        try {
            await link(source, destination);
        } catch {
            // 跨设备或文件系统不支持硬链时退回复制
            await copyFile(source, destination);
        }
        linked++;
    }
    return linked;
}

/* ---------- 小工具 ---------- */

function stage(onProgress: InstallProgress | undefined, name: string): Progress | undefined {
    return onProgress === undefined ? undefined : (done, total) => onProgress(name, done, total);
}
