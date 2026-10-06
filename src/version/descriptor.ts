/**
 * 版本 json 解析与继承合并
 *
 * 版本 json 由 Mojang 与模组加载器安装器写出，未知键远多于我们需要的，一律忽略
 * 加载器版本用 inheritsFrom 指向基础版本，合并之后才是一份可用的描述符
 * 读取失败不抛异常：扫描要能列出其余版本，坏的那个用 problem 说明
 * 加载器 profile 常常不写 type，合并时从父版本取
 * @author IsCibocaz
 * @since 1.0.0
 */

import { dirname } from "node:path";

import { object, parseJson, reader, type Reader } from "../config/read.ts";
import type { Loader, LoaderType } from "../config/types.ts";
import { readText } from "../infra/fs.ts";
import { logger } from "../output/index.ts";

const log = logger("version");

export type VersionType = "release" | "snapshot" | "old_beta" | "old_alpha";

const TYPES = ["release", "snapshot", "old_beta", "old_alpha"] as const;

export interface DownloadEntry {
    readonly sha1: string;
    readonly size: number;
    readonly url: string;
}

export interface AssetIndex {
    readonly id: string;
    readonly sha1: string | null;
    readonly size: number | null;
    readonly totalSize: number | null;
    readonly url: string | null;
}

export interface JavaVersion {
    readonly component: string | null;
    readonly majorVersion: number | null;
}

export interface RuleOs {
    readonly name: string | null;
    readonly version: string | null;
    readonly arch: string | null;
}

export interface Rule {
    readonly action: "allow" | "disallow";
    readonly os: RuleOs | null;
    /** 任意键的布尔开关 */
    readonly features: Readonly<Record<string, boolean>> | null;
}

export interface ConditionalArgument {
    readonly rules: readonly Rule[];
    readonly value: string | readonly string[];
}

/** 裸字符串，或带 rules 的条件项 */
export type ArgumentEntry = string | ConditionalArgument;

export interface Arguments {
    readonly game: readonly ArgumentEntry[];
    readonly jvm: readonly ArgumentEntry[];
}

export interface LibraryDownloads {
    readonly artifact: DownloadEntry | null;
    readonly classifiers: Readonly<Record<string, DownloadEntry>>;
}

export interface Library {
    readonly name: string;
    readonly url: string | null;
    readonly downloads: LibraryDownloads;
    /** os 名 → classifier 键 */
    readonly natives: Readonly<Record<string, string>>;
    readonly rules: readonly Rule[];
    readonly exclude: readonly string[];
}

export interface LoggingFile {
    readonly id: string;
    readonly sha1: string;
    readonly size: number;
    readonly url: string;
}

export interface Logging {
    readonly argument: string;
    readonly file: LoggingFile;
    readonly type: string;
}

export interface Descriptor {
    readonly id: string;
    /** 加载器 profile 可能不写 */
    readonly type: VersionType | null;
    readonly inheritsFrom: string | null;
    readonly mainClass: string | null;
    readonly jar: string | null;
    readonly assets: string | null;
    readonly assetIndex: AssetIndex | null;
    readonly downloads: Readonly<Record<string, DownloadEntry>>;
    readonly javaVersion: JavaVersion | null;
    readonly libraries: readonly Library[];
    readonly arguments: Arguments;
    readonly minecraftArguments: string | null;
    readonly logging: Logging | null;
    readonly complianceLevel: number | null;
    readonly minimumLauncherVersion: number | null;
    readonly time: string | null;
    readonly releaseTime: string | null;
    /** bloomery 标记键里的游戏版本；合并型实例没有 inheritsFrom，只能靠它 */
    readonly declaredGameVersion: string | null;
    readonly declaredLoader: Loader | null;
    /** merged 表示这份 json 是安装时合并出来的自包含版本 */
    readonly layout: "merged" | null;
    /** 版本 json 所在目录，隔离后的游戏文件也在这里 */
    readonly directory: string;
    readonly json: string;
}

export interface DescriptorRead {
    readonly descriptor: Descriptor | null;
    readonly problem: string | null;
}

export interface Resolved {
    readonly descriptor: Descriptor;
    /** 自身到最底层的 id 顺序 */
    readonly chain: readonly string[];
    /** 链断或成环时的说明，正常为 null */
    readonly problem: string | null;
}

/* ---------- 读取 ---------- */

export async function readDescriptor(path: string, id: string): Promise<DescriptorRead> {
    const text = await readText(path);
    if (text === undefined) {
        return { descriptor: null, problem: "版本 json 不存在" };
    }
    const value = parseJson(text, path);
    if (value === undefined) {
        return { descriptor: null, problem: "版本 json 解析失败" };
    }
    const descriptor = parseDescriptor(value, path, id, path);
    if (descriptor === undefined) {
        return { descriptor: null, problem: "版本 json 不是对象" };
    }
    return { descriptor, problem: null };
}

export function parseDescriptor(
    value: unknown,
    where: string,
    id: string,
    json: string,
): Descriptor | undefined {
    const raw = object(value, where);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(where, raw, []);
    const assetIndex = r.object("assetIndex");
    const javaVersion = r.object("javaVersion");
    const logging = r.object("logging");
    const argumentsReader = r.object("arguments");
    const mark = readMark(raw["bloomery"]);

    return {
        id: r.string("id", id),
        type: versionTypeOf(raw["type"]),
        inheritsFrom: nonEmpty(r.nullableString("inheritsFrom", null)),
        mainClass: r.nullableString("mainClass", null),
        jar: r.nullableString("jar", null),
        assets: r.nullableString("assets", null),
        assetIndex: assetIndex === undefined ? null : readAssetIndex(assetIndex),
        downloads: r.map<DownloadEntry>("downloads", {}, readDownloadEntry),
        javaVersion: javaVersion === undefined ? null : readJavaVersion(javaVersion),
        libraries: r.list<Library>("libraries", [], readLibrary),
        arguments: readArguments(argumentsReader),
        minecraftArguments: r.nullableString("minecraftArguments", null),
        logging: logging === undefined ? null : readLogging(logging),
        complianceLevel: r.optionalInteger("complianceLevel", 0) ?? null,
        minimumLauncherVersion: r.optionalInteger("minimumLauncherVersion", 0) ?? null,
        time: r.nullableString("time", null),
        releaseTime: r.nullableString("releaseTime", null),
        declaredGameVersion: mark.gameVersion,
        declaredLoader: mark.loader,
        layout: mark.layout,
        directory: dirname(json),
        json,
    };
}

// 安装时写的标记键：游戏版本与加载器是自包含 json 里认这两样的唯一依据
function readMark(value: unknown): {
    layout: "merged" | null;
    gameVersion: string | null;
    loader: Loader | null;
} {
    const raw = object(value, "bloomery");
    if (raw === undefined) {
        return { layout: null, gameVersion: null, loader: null };
    }
    const gameVersion = typeof raw["gameVersion"] === "string" ? raw["gameVersion"] : null;
    const loaderRaw = object(raw["loader"], "bloomery.loader");
    const type = loaderRaw?.["type"];
    const version = loaderRaw?.["version"];
    return {
        layout: raw["layout"] === "merged" ? "merged" : null,
        gameVersion: gameVersion === "" ? null : gameVersion,
        loader:
            typeof type === "string" && LOADER_TYPES.includes(type as LoaderType)
                ? {
                      type: type as LoaderType,
                      version: typeof version === "string" && version !== "" ? version : null,
                  }
                : null,
    };
}

const LOADER_TYPES: readonly LoaderType[] = ["vanilla", "fabric", "forge", "neoforge", "quilt"];

function readAssetIndex(r: Reader): AssetIndex {
    return {
        id: r.string("id", ""),
        sha1: r.nullableString("sha1", null),
        size: r.optionalInteger("size", 0) ?? null,
        totalSize: r.optionalInteger("totalSize", 0) ?? null,
        url: r.nullableString("url", null),
    };
}

function readJavaVersion(r: Reader): JavaVersion {
    return {
        component: r.nullableString("component", null),
        majorVersion: r.optionalInteger("majorVersion", 1) ?? null,
    };
}

function readLogging(r: Reader): Logging | null {
    const fileReader = r.object("file");
    const argument = r.string("argument", "");
    const type = r.string("type", "");
    if (fileReader === undefined || argument === "") {
        return null;
    }
    return { argument, file: readLoggingFile(fileReader), type };
}

function readLoggingFile(r: Reader): LoggingFile {
    return {
        id: r.string("id", ""),
        sha1: r.string("sha1", ""),
        size: r.integer("size", 0, 0),
        url: r.string("url", ""),
    };
}

function readArguments(r: Reader | undefined): Arguments {
    if (r === undefined) {
        return { game: [], jvm: [] };
    }
    return {
        game: r.list<ArgumentEntry>("game", [], readArgument),
        jvm: r.list<ArgumentEntry>("jvm", [], readArgument),
    };
}

function readArgument(value: unknown, at: string): ArgumentEntry | undefined {
    if (typeof value === "string") {
        return value;
    }
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, []);
    const rules = readRules(r);
    const rawValue = raw["value"];
    if (typeof rawValue === "string") {
        return { rules, value: rawValue };
    }
    if (Array.isArray(rawValue)) {
        const values = rawValue.filter((item): item is string => typeof item === "string");
        return values.length === 0 ? undefined : { rules, value: values };
    }
    log.warn("%s 的 value 既不是字符串也不是数组，已忽略这一项", at);
    return undefined;
}

function readRules(r: Reader): Rule[] {
    return r.list<Rule>("rules", [], (value, at) => {
        const raw = object(value, at);
        if (raw === undefined) {
            return undefined;
        }
        const item = reader(at, raw, []);
        const os = item.object("os");
        return {
            action: item.enumeration("action", ["allow", "disallow"], "allow"),
            os:
                os === undefined
                    ? null
                    : {
                          name: os.nullableString("name", null),
                          version: os.nullableString("version", null),
                          arch: os.nullableString("arch", null),
                      },
            features: readFeatures(raw["features"]),
        };
    });
}

function readFeatures(value: unknown): Readonly<Record<string, boolean>> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return null;
    }
    const features: Record<string, boolean> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "boolean") {
            features[key] = entry;
        }
    }
    return features;
}

function readLibrary(value: unknown, at: string): Library | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, []);
    const name = r.string("name", "");
    if (name === "") {
        log.warn("%s 缺 name，已忽略这条库", at);
        return undefined;
    }
    const downloads = r.object("downloads");
    const extract = r.object("extract");
    return {
        name,
        url: r.nullableString("url", null),
        downloads:
            downloads === undefined
                ? { artifact: null, classifiers: {} }
                : readLibraryDownloads(downloads),
        natives: r.map<string>("natives", {}, stringItem),
        rules: readRules(r),
        exclude: extract === undefined ? [] : extract.list<string>("exclude", [], stringItem),
    };
}

function readLibraryDownloads(r: Reader): LibraryDownloads {
    const artifact = r.object("artifact");
    return {
        artifact: artifact === undefined ? null : (readEntry(artifact) ?? null),
        classifiers: r.map<DownloadEntry>("classifiers", {}, readDownloadEntry),
    };
}

function readDownloadEntry(value: unknown, at: string): DownloadEntry | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    return readEntry(reader(at, raw, []));
}

function readEntry(r: Reader): DownloadEntry | undefined {
    const url = r.string("url", "");
    if (url === "") {
        return undefined;
    }
    return { sha1: r.string("sha1", ""), size: r.integer("size", 0, 0), url };
}

/* ---------- 合并 ---------- */

export function mergeDescriptors(parent: Descriptor, child: Descriptor): Descriptor {
    return {
        id: child.id,
        type: child.type ?? parent.type,
        inheritsFrom: null,
        mainClass: child.mainClass ?? parent.mainClass,
        jar: child.jar ?? parent.jar,
        assets: child.assets ?? parent.assets,
        assetIndex: child.assetIndex ?? parent.assetIndex,
        downloads: { ...parent.downloads, ...child.downloads },
        javaVersion: child.javaVersion ?? parent.javaVersion,
        libraries: mergeLibraries(parent.libraries, child.libraries),
        arguments: {
            game: [...parent.arguments.game, ...child.arguments.game],
            jvm: [...parent.arguments.jvm, ...child.arguments.jvm],
        },
        minecraftArguments: child.minecraftArguments ?? parent.minecraftArguments,
        logging: child.logging ?? parent.logging,
        complianceLevel: child.complianceLevel ?? parent.complianceLevel,
        minimumLauncherVersion: child.minimumLauncherVersion ?? parent.minimumLauncherVersion,
        time: child.time ?? parent.time,
        releaseTime: child.releaseTime ?? parent.releaseTime,
        declaredGameVersion: child.declaredGameVersion ?? parent.declaredGameVersion,
        declaredLoader: child.declaredLoader ?? parent.declaredLoader,
        layout: child.layout ?? parent.layout,
        directory: child.directory,
        json: child.json,
    };
}

// 子在前，父里同名的不再进
function mergeLibraries(parent: readonly Library[], child: readonly Library[]): Library[] {
    const names = new Set(child.map((library) => library.name));
    return [...child, ...parent.filter((library) => !names.has(library.name))];
}

// 沿 inheritsFrom 上溯；链断或成环时返回已合并的部分
export function resolveDescriptor(
    byId: ReadonlyMap<string, Descriptor>,
    id: string,
): Resolved | undefined {
    const start = byId.get(id);
    if (start === undefined) {
        return undefined;
    }

    const chain: string[] = [id];
    const seen = new Set<string>([id]);
    let merged = start;
    let next = start.inheritsFrom;
    let problem: string | null = null;

    while (next !== null) {
        if (seen.has(next)) {
            problem = `继承链成环：${next}`;
            break;
        }
        const parent = byId.get(next);
        if (parent === undefined) {
            problem = `找不到继承的版本 ${next}`;
            break;
        }
        merged = mergeDescriptors(parent, merged);
        chain.push(next);
        seen.add(next);
        next = parent.inheritsFrom;
    }

    return { descriptor: merged, chain, problem };
}

/* ---------- 加载器识别 ---------- */

const LOADER_LIBRARIES: ReadonlyArray<readonly [LoaderType, RegExp]> = [
    ["fabric", /^net\.fabricmc:fabric-loader:/],
    ["quilt", /^org\.quiltmc:quilt-loader:/],
    ["neoforge", /^net\.neoforged:(?:neoforge|fmlloader):/],
    ["forge", /^net\.minecraftforge:(?:forge|fmlloader):/],
];

// 库名对不上时按 id 关键字兜底，neoforge 要先于 forge 判
const LOADER_KEYWORDS: ReadonlyArray<readonly [LoaderType, RegExp]> = [
    ["neoforge", /neoforge/i],
    ["forge", /forge/i],
    ["fabric", /fabric/i],
    ["quilt", /quilt/i],
];

export function loaderOf(descriptor: Descriptor): Loader {
    // 合并型实例的库是两层的并集，靠库坐标认加载器会认错，标记键优先
    if (descriptor.declaredLoader !== null) {
        return descriptor.declaredLoader;
    }
    for (const library of descriptor.libraries) {
        for (const [type, pattern] of LOADER_LIBRARIES) {
            if (pattern.test(library.name)) {
                return { type, version: coordinateVersion(library.name) };
            }
        }
    }
    for (const [type, pattern] of LOADER_KEYWORDS) {
        if (pattern.test(descriptor.id)) {
            return { type, version: null };
        }
    }
    return { type: "vanilla", version: null };
}

// group:artifact:version → version
function coordinateVersion(name: string): string | null {
    const parts = name.split(":");
    return parts.length >= 3 ? (parts[2] ?? null) : null;
}

/* ---------- 游戏版本 ---------- */

// 这些库的坐标里带着游戏版本；forge 系是 <游戏版本>-<加载器版本>，只取前半
const VERSION_LIBRARIES: ReadonlyArray<{ pattern: RegExp; prefix: boolean }> = [
    { pattern: /^net\.fabricmc:intermediary:(.+)$/, prefix: false },
    { pattern: /^org\.quiltmc:hashed:(.+)$/, prefix: false },
    { pattern: /^net\.minecraftforge:(?:forge|fmlloader):(.+)$/, prefix: true },
    { pattern: /^net\.neoforged:(?:neoforge|fmlloader|neoform):(.+)$/, prefix: true },
];

// 版本号的样子：正式版、预览、以及远古的 a / b / c / rd 系
const VERSION_TOKEN =
    /(?:rd-\d+|inf-\d+|[abc]\d+\.\d+(?:\.\d+)?[a-z]?|\d+\.\d+(?:\.\d+)?(?:-(?:pre|rc)\d+)?)/;

// 判断这份版本是哪一版游戏：标记键与 inheritsFrom 最准，其次看加载器库的坐标，
// 再次从 id 里找版本样的片段；都认不出返回 null（比如被改过名的原版）
export function gameVersionOf(descriptor: Descriptor): string | null {
    if (descriptor.declaredGameVersion !== null) {
        return descriptor.declaredGameVersion;
    }
    if (descriptor.inheritsFrom !== null) {
        return descriptor.inheritsFrom;
    }

    for (const library of descriptor.libraries) {
        for (const { pattern, prefix } of VERSION_LIBRARIES) {
            const value = pattern.exec(library.name)?.[1];
            if (value !== undefined) {
                return prefix ? (value.split("-")[0] ?? value) : value;
            }
        }
    }

    return VERSION_TOKEN.exec(descriptor.id)?.[0] ?? null;
}

// 版本 json 里的 Java 主版本要求：1.12.2 是 8，1.20.6 是 21
// 挑跑官方安装器的 java 要用它；那份 json 此刻还没落盘，只能从内存里读
export function requiredJavaOf(raw: unknown): number | null {
    const javaVersion = object(object(raw, "version")?.["javaVersion"], "version.javaVersion");
    const major = javaVersion?.["majorVersion"];
    return typeof major === "number" && Number.isFinite(major) ? major : null;
}

/* ---------- 小工具 ---------- */

function versionTypeOf(value: unknown): VersionType | null {
    return typeof value === "string" && (TYPES as readonly string[]).includes(value)
        ? (value as VersionType)
        : null;
}

function nonEmpty(value: string | null): string | null {
    if (value === null) {
        return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

function stringItem(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
