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

import { copyFile, link, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { object, parseJson } from "../config/read.ts";
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
    type DownloadFailure,
    type DownloadOutcome,
    fetchBuffer,
    type DownloadReport,
    type DownloadTask,
    type Progress,
    type TransferOptions,
} from "../infra/download.ts";
import { pathExists, writeAtomic } from "../infra/fs.ts";
import { sourcesOf } from "../infra/source.ts";
import { logger, print } from "../output/index.ts";
import { readDescriptor, type Descriptor, type DownloadEntry, type Library } from "./descriptor.ts";
import { installWithOfficial, type OfficialInstallReport } from "./official.ts";
import {
    defaultVersionName,
    fetchLoaderProfile,
    installerUrlOf,
    listLoaderVersionsFor,
    resolveLoaderVersion,
    type LoaderName,
    type LoaderSpec,
} from "./loader.ts";
import { fetchManifest, findVersion } from "./manifest.ts";

const log = logger("install");

const ASSET_ROOT = "https://resources.download.minecraft.net";

const EMPTY_REPORT: DownloadReport = {
    downloaded: 0,
    skipped: 0,
    bytes: 0,
    failures: [],
    outcomes: [],
};

export interface InstallProgress {
    (stage: string, done: number, total: number, bytes: boolean, existing: boolean): void;
}

export interface InstallInput {
    readonly folderPath: string;
    /** 要装的 Minecraft 版本，例如 1.20.6 */
    readonly versionId: string;
    /** 版本目录名与显示名，省略时按版本与加载器推导 */
    readonly name?: string | undefined;
    readonly loader?: LoaderSpec | null | undefined;
    readonly network: Network;
    readonly download: DownloadSetting;
    /** false 时跳过资源对象，只装游戏本体 */
    readonly assets?: boolean | undefined;
    /** forge 与 neoforge 要跑官方安装器，这是挑好的 java；由调用方解析 */
    readonly officialJava?: string | undefined;
    /** 过程提示；--json 时调用方不给 */
    readonly logLine?: ((text: string) => void) | undefined;
    readonly onProgress?: InstallProgress | undefined;
}

export interface OfficialNote {
    readonly versionDirectory: string;
    readonly java: string;
}

export interface InstallReport {
    readonly name: string;
    readonly versionId: string;
    readonly loader: { readonly name: LoaderName; readonly version: string } | null;
    /** 加载器版本要的基础版本是本来就在，还是这次顺带装的 */
    readonly base: "none" | "present" | "installed";
    readonly clientJar: boolean;
    readonly libraries: DownloadReport;
    readonly natives: {
        readonly jars: number;
        readonly files: number;
        readonly report: DownloadReport;
    };
    readonly assets: { readonly index: DownloadReport; readonly objects: DownloadReport } | null;
    /** 走官方安装器时才有 */
    readonly official: OfficialNote | null;
    /** 下载四类与收尾各花了多久，用来定位"进度条走完却卡住" */
    readonly timing: { readonly downloadMs: number; readonly finishMs: number };
    readonly warnings: readonly string[];
}

interface BodyResult {
    /** 下载四类与收尾各花了多久 */
    readonly timing: { readonly downloadMs: number; readonly finishMs: number };
    readonly clientJar: boolean;
    readonly libraries: DownloadReport;
    readonly natives: InstallReport["natives"];
    readonly assets: InstallReport["assets"];
}

export async function installVersion(input: InstallInput): Promise<InstallReport> {
    const warnings: string[] = [];
    const installStartedAt = Date.now();
    const loader = input.loader ?? null;
    const options: TransferOptions = {
        timeoutMs: input.network.timeoutMs,
        retries: input.network.retries,
        proxy: input.network.proxy ?? null,
        noProxy: input.network.noProxy,
        verify: input.download.verify,
        concurrency: input.network.concurrency,
        sources: sourcesOf(input.download),
    };

    // 加载器版本要先解出来：目录名里带的是具体版本号，不是 latest
    // forge 与 neoforge 没有 meta，版本号要么用户给、要么从清单挑最新的正式版
    const isOfficial =
        loader !== null &&
        installerUrlOf(loader.name, input.versionId, loader.version ?? "") !== null;
    const loaderVersion =
        loader === null
            ? null
            : isOfficial
              ? await officialLoaderVersion(
                    loader.name,
                    input.versionId,
                    loader.version,
                    options,
                    (text) => input.logLine?.(text),
                )
              : await resolveLoaderVersion(loader, input.versionId, options);

    // forge 的版本号自带游戏版本前缀（1.20.6-50.2.10），目录名里不重复放
    const shortVersion =
        loaderVersion !== null && loaderVersion.startsWith(`${input.versionId}-`)
            ? loaderVersion.slice(input.versionId.length + 1)
            : loaderVersion;
    const name = input.name ?? defaultVersionName(input.versionId, loader, shortVersion);
    assertName(name);
    await assertFree(input.folderPath, name);

    let base: InstallReport["base"] = "none";
    let official: OfficialNote | null = null;
    let json: Record<string, unknown>;
    if (loader === null) {
        json = await fetchVanillaJson(input.versionId, options);
    } else if (isOfficial) {
        // forge 与 neoforge：跑官方安装器，我们的实例继承它写出的版本目录
        base = await ensureBase(input, options, warnings);
        const installed = await runOfficialInstaller(
            input,
            loader.name,
            loaderVersion ?? "",
            options,
        );
        official = { versionDirectory: installed.versionDirectory, java: installed.java };
        // 安装器写出的目录改名接管：实例名就是 name，继承链只留一层
        if (installed.versionDirectory !== name) {
            await adoptVersion(input.folderPath, installed.versionDirectory, name);
            warnings.push(`安装器目录 ${installed.versionDirectory} 改名 ${name}`);
        }
        json = await readVersionJson(join(input.folderPath, "versions", name, `${name}.json`));
    } else {
        base = await ensureBase(input, options, warnings);
        json = await fetchLoaderProfile(loader, input.versionId, loaderVersion ?? "", options);
    }

    const versionDir = join(input.folderPath, "versions", name);
    const jsonPath = join(versionDir, `${name}.json`);
    // json 的 id 保持原样：那是游戏版本号，改写掉就再也认不出这份是 1.20.6 了
    // 目录名才是显示名，客户端 jar 也跟着目录名放
    await writeAtomic(jsonPath, `${JSON.stringify(json, null, 4)}\n`);

    const read = await readDescriptor(jsonPath, name);
    if (read.descriptor === null) {
        throw new AppError("install", "VersionBroken", {
            context: { detail: name, problem: read.problem ?? "" },
        });
    }

    const body = await installBody(input, name, jsonPath, read.descriptor, options, warnings);
    log.info("装好 %s", name);

    return {
        name,
        versionId: input.versionId,
        loader: loader === null ? null : { name: loader.name, version: loaderVersion ?? "" },
        base,
        ...body,
        official,
        warnings,
    };
}

// 只问地址在不在，不拉内容
// 返回 false 才代表确定没有；true 与 undefined 都不拦人
// 这里用的是裸 fetch，不走设置里的代理，也不代表所有站点都支持 HEAD，所以只在 404 时才下结论
async function addressExists(url: string, options: TransferOptions): Promise<boolean | undefined> {
    try {
        const response = await fetch(url, {
            method: "HEAD",
            signal: AbortSignal.timeout(options.timeoutMs),
        });
        return response.status === 404 ? false : true;
    } catch {
        return undefined;
    }
}

// forge 与 neoforge 的版本号：给了就用，没给就取清单里最新的正式版
async function officialLoaderVersion(
    name: LoaderName,
    game: string,
    wanted: string | null | undefined,
    options: TransferOptions,
    say: (text: string) => void,
): Promise<string> {
    if (wanted !== null && wanted !== undefined && wanted !== "") {
        // 指定了版本就只验地址存不存在：forge 的清单是几 MB 的 JSON，国内拉它经常超时
        const url = installerUrlOf(name, game, wanted);
        if (url !== null && (await addressExists(url, options)) === false) {
            throw new AppError("loader", "VersionNotFound", {
                context: {
                    detail: `${name} ${wanted} 在 ${game} 上没有安装器`,
                    hint: "版本号带游戏版本前缀，或省略取最新",
                },
            });
        }
        if (url !== null) {
            return wanted;
        }
        // 地址拼不出来才退回清单校验
        const list = await listLoaderVersionsFor(name, game, options);
        const known = list.some(
            (item) =>
                item.version === wanted ||
                item.version.endsWith(`-${wanted}`) ||
                item.version === `${game}-${wanted}`,
        );
        if (list.length > 0 && !known) {
            const newest = list.find((item) => item.channel === "release") ?? list[0];
            throw new AppError("loader", "VersionNotFound", {
                context: {
                    detail: `${name} ${wanted} 与 ${game} 不匹配`,
                    available: `${game} 上最新的是 ${newest?.version ?? "未知"}`,
                    hint: "省略版本号就自动取该游戏版本上最新的正式版",
                },
            });
        }
        return wanted;
    }
    print(
        `正在取 ${name} 的版本清单（${name === "forge" ? "文件较大，国内可能较慢；指定 @<版本> 可跳过" : "稍等"}）…`,
    );
    const list = await listLoaderVersionsFor(name, game, options);
    const picked = list.find((item) => item.channel === "release") ?? list[0];
    if (picked === undefined) {
        throw new AppError("loader", "VersionNotFound", {
            context: { detail: `${name} 没有 ${game} 的版本` },
        });
    }
    return picked.version;
}

// 安装器写出的版本目录整份改名：目录、json 文件名、json 里的 id 与 jar 一起改
export async function adoptVersion(folderPath: string, from: string, to: string): Promise<void> {
    const versionsRoot = join(folderPath, "versions");
    const source = join(versionsRoot, from);
    const target = join(versionsRoot, to);
    await rm(target, { recursive: true, force: true });
    await rename(source, target);

    const fromJson = join(target, `${from}.json`);
    if (!(await pathExists(fromJson))) {
        return;
    }
    const raw = parseJson(await readFile(fromJson, "utf8"), fromJson);
    const data: Record<string, unknown> = object(raw, fromJson) ?? {};
    data["id"] = to;

    // 客户端 jar 跟着实例名走，json 里的 jar 字段可能是 id 也可能是文件名
    const jarFile = `${from}.jar`;
    if (await pathExists(join(target, jarFile))) {
        await rename(join(target, jarFile), join(target, `${to}.jar`));
        if (data["jar"] === from || data["jar"] === jarFile) {
            data["jar"] = to;
        }
    }
    await writeAtomic(join(target, `${to}.json`), `${JSON.stringify(data, null, 4)}\n`);
    await rm(fromJson, { force: true });
    log.info("版本目录 %s 改名 %s", from, to);
}

async function readVersionJson(path: string): Promise<Record<string, unknown>> {
    const raw = parseJson(await readFile(path, "utf8"), path);
    return object(raw, path) ?? {};
}

// 跑官方安装器前要先有 java：调用方（CLI）没给就说明这条路径没准备好
async function runOfficialInstaller(
    input: InstallInput,
    name: LoaderName,
    loaderVersion: string,
    options: TransferOptions,
): Promise<OfficialInstallReport> {
    const java = input.officialJava;
    if (java === undefined) {
        throw new AppError("install", "JavaNotFound", {
            context: {
                detail: `${name} 官方安装器缺少 java`,
                hint: "装 java，或 bloomery java scan",
            },
        });
    }
    log.info("%s 走官方安装器（java %s）", name, java);
    return await installWithOfficial({
        name,
        game: input.versionId,
        loaderVersion,
        folderPath: input.folderPath,
        java,
        options,
        onLine: input.logLine,
    });
}

// 装一份版本 json 描述的全部内容
async function installBody(
    input: InstallInput,
    name: string,
    jsonPath: string,
    descriptor: Descriptor,
    options: TransferOptions,
    warnings: string[],
): Promise<BodyResult> {
    const versionDir = dirname(jsonPath);
    const startedAt = Date.now();
    let downloadMs = 0;
    const librariesRoot = join(input.folderPath, "libraries");
    const assetsRoot = join(input.folderPath, "assets");
    const context = platformContext();

    // 资源索引是唯一的硬前置：对象清单要先拿到，索引本身很小
    const assetPlan =
        input.assets === false
            ? null
            : await prepareAssets(descriptor, assetsRoot, options, warnings);

    const hasClientEntry = descriptor.downloads["client"] !== undefined;
    const client = await clientJarTask(descriptor, join(versionDir, `${name}.jar`), warnings);
    const { libraries: libraryTasks, natives: nativeTasks } = splitTasks(
        descriptor,
        context,
        librariesRoot,
    );

    // 四类各跑一个队列、同时进行；每条通道自己报进度，终端上就是四行条各走各的
    // 并发不能平均分：资源动辄几千个文件，平均分只给它 2 个连接，会慢成瓶颈
    // 每类保底 1 个，剩下的名额全给任务最多的那类，总数仍等于设置里的并发数
    const lanes: Array<readonly [string, readonly DownloadTask[]]> = [
        ["客户端 jar", client === null ? [] : [client]],
        ["库", libraryTasks],
        ["natives", nativeTasks],
        ["资源", assetPlan?.tasks ?? []],
    ];
    const active = lanes.filter(([, tasks]) => tasks.length > 0);
    const budget = new Map(active.map(([label]) => [label, 1]));
    const largest = [...active].sort((left, right) => right[1].length - left[1].length)[0];
    if (largest !== undefined) {
        budget.set(largest[0], Math.max(1, options.concurrency - (active.length - 1)));
    }
    log.debug("并发分配 %s", [...budget].map(([label, count]) => `${label}=${count}`).join(" "));

    const lane = (label: string, tasks: readonly DownloadTask[]): Promise<DownloadReport> =>
        tasks.length === 0
            ? Promise.resolve(EMPTY_REPORT)
            : downloadAll(
                  tasks,
                  { ...options, concurrency: budget.get(label) ?? 1 },
                  stage(input.onProgress, label),
              );

    const downloadStartedAt = Date.now();
    const [clientReport, libraries, nativeReport, assetObjects] = await Promise.all([
        lane("客户端 jar", client === null ? [] : [client]),
        lane("库", libraryTasks),
        lane("natives", nativeTasks),
        lane("资源", assetPlan?.tasks ?? []),
    ]);
    downloadMs = Date.now() - downloadStartedAt;
    log.info("四类下载用了 %d ms", downloadMs);

    // 客户端 jar 缺了整个版本都起不来，单独拦下来
    if (clientReport.failures.length > 0) {
        throw new AppError("install", "DependencyMissing", {
            context: { detail: `客户端 jar：${clientReport.failures[0]?.error ?? ""}` },
        });
    }

    const selection = await nativeJars({
        libraries: descriptor.libraries,
        context,
        librariesRoot,
    });
    const files = await extractNatives(selection.jars, join(versionDir, "natives"));

    if (assetPlan !== null) {
        if (assetPlan.parsed.virtual) {
            const linked = await layoutVirtual(assetsRoot, assetPlan.parsed);
            log.info("索引 %s 是 virtual 的，另铺了 %d 个对象", assetPlan.id, linked);
        }
        if (assetPlan.parsed.mapToResources) {
            warnings.push(`索引 ${assetPlan.id} 要 map_to_resources，这一版还没处理`);
        }
    }

    return {
        clientJar: hasClientEntry,
        libraries,
        natives: { jars: selection.jars.length, files, report: nativeReport },
        assets: assetPlan === null ? null : { index: assetPlan.index, objects: assetObjects },
        timing: { downloadMs, finishMs: Date.now() - downloadStartedAt - downloadMs },
    };
}

// 加载器版本靠 inheritsFrom 指向基础版本，基础版本不在就先按原版装一份
async function ensureBase(
    input: InstallInput,
    options: TransferOptions,
    warnings: string[],
): Promise<"present" | "installed"> {
    const id = input.versionId;
    const jsonPath = join(input.folderPath, "versions", id, `${id}.json`);
    if (await pathExists(jsonPath)) {
        return "present";
    }

    const json = await fetchVanillaJson(id, options);
    await writeAtomic(jsonPath, `${JSON.stringify(json, null, 4)}\n`);

    const read = await readDescriptor(jsonPath, id);
    if (read.descriptor === null) {
        throw new AppError("install", "VersionBroken", {
            context: { detail: id, problem: read.problem ?? "" },
        });
    }
    await installBody(input, id, jsonPath, read.descriptor, options, warnings);
    log.info("顺带装好基础版本 %s", id);
    return "installed";
}

// 目录名就是版本名，重名一律拒绝
async function assertFree(folderPath: string, name: string): Promise<void> {
    if (await pathExists(join(folderPath, "versions", name))) {
        throw new AppError("install", "VersionExists", {
            context: { text: `已经存在名为“${name}”的版本` },
        });
    }
}

const ILLEGAL_NAME = /[/\\:*?"<>|]/;

function assertName(name: string): void {
    if (name.trim() === "" || ILLEGAL_NAME.test(name)) {
        throw new AppError("install", "UsageError", {
            context: { detail: `版本名不能为空，也不能含 / \\ : * ? " < > |：${name}` },
        });
    }
}

/* ---------- 版本 json ---------- */

async function fetchVanillaJson(
    id: string,
    options: TransferOptions,
): Promise<Record<string, unknown>> {
    const manifest = await fetchManifest(options);
    const version = findVersion(manifest, id);
    if (version === undefined) {
        throw new AppError("install", "VersionNotFound", {
            context: { detail: id, latest: manifest.latest.release ?? "未知" },
        });
    }

    const buffer = await fetchBuffer(version.url, options);
    const raw = object(parseJson(buffer.toString("utf8"), version.url), version.url);
    if (raw === undefined) {
        throw new AppError("install", "VersionBroken", {
            context: { detail: `${id} 的 json 读不出来` },
        });
    }
    return raw;
}

/* ---------- 客户端 jar ---------- */

// 客户端 jar 的任务；没有下载信息或本地已经有时给 null
async function clientJarTask(
    descriptor: Descriptor,
    clientJar: string,
    warnings: string[],
): Promise<DownloadTask | null> {
    const entry = descriptor.downloads["client"];
    if (entry === undefined) {
        // 加载器版本靠 inheritsFrom 用基础版本的 jar，没有下载信息是正常的
        if (descriptor.inheritsFrom === null) {
            warnings.push("版本 json 里没有客户端 jar 的下载信息");
        }
        return null;
    }
    if (await pathExists(clientJar)) {
        return null;
    }
    return { url: entry.url, target: clientJar, sha1: entry.sha1, size: entry.size };
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

interface AssetPlan {
    readonly id: string;
    readonly index: DownloadReport;
    readonly parsed: AssetIndex;
    readonly tasks: readonly DownloadTask[];
}

// 只下索引并算出对象任务，对象本体交给合并队列
async function prepareAssets(
    descriptor: Descriptor,
    assetsRoot: string,
    options: TransferOptions,
    warnings: string[],
): Promise<AssetPlan | null> {
    const id = descriptor.assetIndex?.id ?? descriptor.assets;
    if (id === null || id === "") {
        // 继承型版本用的是基础版本的资源，这里没有索引是正常的
        if (descriptor.inheritsFrom === null) {
            warnings.push("版本 json 里没有资源索引信息");
        }
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

    return { id, index, parsed, tasks: objectTasks(assetsRoot, parsed) };
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
    return onProgress === undefined
        ? undefined
        : (done, total, bytes, _target, existing) => onProgress(name, done, total, bytes, existing);
}
