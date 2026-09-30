/**
 * 模组加载器
 *
 * 只接 fabric：meta 接口给出可用加载器与 profile json
 * profile 里的 libraries 只有 url 没有 downloads，靠 dependency 那边的 Maven 回退拼地址
 * forge / neoforge 要跑官方安装器，quilt 没接，都先报未实现
 * @author IsCibocaz
 * @since 1.0.0
 */

import { object, parseJson } from "../config/read.ts";
import { AppError } from "../error/index.ts";
import { fetchBuffer, type FetchOptions } from "../infra/download.ts";
import { logger } from "../output/index.ts";

const log = logger("loader");

// fabric 与 quilt 的 meta 是同一套结构：<base>/versions/loader 与 <base>/versions/game
const FABRIC_BASE = "https://meta.fabricmc.net/v2";
const QUILT_BASE = "https://meta.quiltmc.org/v3";
const FORGE_META = "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json";
const NEOFORGE_META =
    "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge";

// 各家加载器的版本清单，形状各不相同，见下面的解析
const LOADER_LISTS: Record<LoaderName, string> = {
    fabric: `${FABRIC_BASE}/versions/loader`,
    quilt: `${QUILT_BASE}/versions/loader`,
    forge: FORGE_META,
    neoforge: NEOFORGE_META,
};

// 发布通道从版本号本身判断：fabric 的 stable 只标最新那版，不能当通道用
export type LoaderChannel = "release" | "beta" | "alpha";

const ALPHA = /alpha/i;
const BETA = /(beta|rc|pre|snapshot|preview)/i;

export function channelOf(version: string): LoaderChannel {
    if (ALPHA.test(version)) {
        return "alpha";
    }
    return BETA.test(version) ? "beta" : "release";
}

// channel 为 undefined 表示不过滤
export function filterChannel(
    list: readonly LoaderVersion[],
    channel: LoaderChannel | undefined,
): readonly LoaderVersion[] {
    return channel === undefined ? list : list.filter((item) => item.channel === channel);
}

export type LoaderName = "fabric" | "forge" | "neoforge" | "quilt";

const NAMES: readonly LoaderName[] = ["fabric", "forge", "neoforge", "quilt"];

export interface LoaderVersion {
    readonly version: string;
    /** forge 的清单按游戏版本分组，其余为 null */
    readonly gameVersion: string | null;
    readonly channel: LoaderChannel;
}

export interface LoaderSpec {
    readonly name: LoaderName;
    /** null 表示 latest */
    readonly version: string | null;
}

// 写法：<名字> 或 <名字>@<版本|latest>
export function parseLoaderSpec(text: string): LoaderSpec | undefined {
    const at = text.indexOf("@");
    const name = (at < 0 ? text : text.slice(0, at)).trim().toLowerCase();
    const version = at < 0 ? "" : text.slice(at + 1).trim();

    if (!(NAMES as readonly string[]).includes(name)) {
        return undefined;
    }
    return version === "" || version.toLowerCase() === "latest"
        ? { name: name as LoaderName, version: null }
        : { name: name as LoaderName, version };
}

export type Transport = (url: string, options: FetchOptions) => Promise<Buffer>;

// 某个游戏版本上可用的加载器版本
export async function listLoaderVersionsFor(
    name: LoaderName,
    game: string,
    options: FetchOptions,
    transport?: Transport,
): Promise<readonly LoaderVersion[]> {
    switch (name) {
        case "fabric":
        case "quilt": {
            const base = name === "fabric" ? FABRIC_BASE : QUILT_BASE;
            const url = `${base}/versions/loader/${encodeURIComponent(game)}`;
            try {
                return gameScoped(await fetchJson(url, options, transport));
            } catch (error) {
                // 不支持的游戏版本会回 4xx，按"没有"处理；网络问题继续抛
                const status = statusOf(error);
                if (status !== undefined && status >= 400 && status < 500) {
                    log.debug("%s 不支持 %s（HTTP %d）", name, game, status);
                    return [];
                }
                throw error;
            }
        }
        case "forge": {
            const grouped = object(await fetchJson(FORGE_META, options, transport), "forge");
            const list = grouped?.[game];
            if (!Array.isArray(list)) {
                return [];
            }
            return list
                .filter((item): item is string => typeof item === "string")
                .map((version) => ({ version, gameVersion: game, channel: channelOf(version) }))
                .sort((left, right) => compare(right.version, left.version));
        }
        case "neoforge": {
            const all = await listLoaderVersions("neoforge", options, transport);
            return all.filter((item) => gameOfNeoForge(item.version) === game);
        }
    }
}

// 这个加载器支持哪些游戏版本
export async function listLoaderGames(
    name: LoaderName,
    options: FetchOptions,
    transport?: Transport,
): Promise<readonly string[]> {
    switch (name) {
        case "fabric":
        case "quilt": {
            const base = name === "fabric" ? FABRIC_BASE : QUILT_BASE;
            const raw = await fetchJson(`${base}/versions/game`, options, transport);
            return entries(raw)
                .map((entry) => entry["version"])
                .filter((version): version is string => typeof version === "string");
        }
        case "forge": {
            const grouped = object(await fetchJson(FORGE_META, options, transport), "forge");
            return Object.keys(grouped ?? {}).sort((left, right) => compare(right, left));
        }
        case "neoforge": {
            const all = await listLoaderVersions("neoforge", options, transport);
            const games = new Set<string>();
            for (const item of all) {
                const game = gameOfNeoForge(item.version);
                if (game !== null) {
                    games.add(game);
                }
            }
            return [...games].sort((left, right) => compare(right, left));
        }
    }
}

// 按游戏版本查的 meta 把加载器包在 loader 字段里
function gameScoped(raw: unknown): LoaderVersion[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: LoaderVersion[] = [];
    for (const item of raw) {
        const entry = object(item, "loader[]");
        const version = object(entry?.["loader"], "loader[].loader")?.["version"];
        if (typeof version === "string") {
            out.push({ version, gameVersion: null, channel: channelOf(version) });
        }
    }
    return out;
}

// neo 的版本号前两段对应游戏版本：20.6.119 -> 1.20.6，26.2.0.88 -> 26.2
function gameOfNeoForge(version: string): string | null {
    const parts = version.split(".");
    const major = Number.parseInt(parts[0] ?? "", 10);
    const minor = Number.parseInt(parts[1] ?? "", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor)) {
        return null;
    }
    return major >= 26 ? `${major}.${minor}` : `1.${major}.${minor}`;
}

// 各加载器的可用版本，新到旧；forge 与 neoforge 的清单是升序，翻过来
export async function listLoaderVersions(
    name: LoaderName,
    options: FetchOptions,
    transport?: Transport,
): Promise<readonly LoaderVersion[]> {
    const raw = await fetchJson(LOADER_LISTS[name], options, transport);
    switch (name) {
        case "fabric":
        case "quilt":
            return plainList(raw);
        case "forge":
            return byGame(raw);
        case "neoforge":
            return tagged(raw);
    }
}

// fabric 与 quilt：[{ version, stable? }]，接口已按新到旧排
function plainList(raw: unknown): LoaderVersion[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: LoaderVersion[] = [];
    for (const item of raw) {
        const entry = object(item, "loader[]");
        const version = entry?.["version"];
        if (typeof version !== "string") {
            continue;
        }
        out.push({ version, gameVersion: null, channel: channelOf(version) });
    }
    return out;
}

// fetchBuffer 把 HttpStatusError 包在 cause 里，状态码要顺着链找
function statusOf(error: unknown): number | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth++) {
        const status = (current as { status?: unknown }).status;
        if (typeof status === "number") {
            return status;
        }
        current = (current as { cause?: unknown }).cause;
    }
    return undefined;
}

function entries(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.map((item) => object(item, "[]") ?? {}).filter((item) => item !== undefined)
        : [];
}

// forge：{ "1.20.6": ["1.20.6-56.0.1", ...] }，值是完整版本号
function byGame(raw: unknown): LoaderVersion[] {
    const grouped = object(raw, "forge.maven-metadata");
    if (grouped === undefined) {
        return [];
    }
    const out: LoaderVersion[] = [];
    for (const [game, value] of Object.entries(grouped)) {
        if (!Array.isArray(value)) {
            continue;
        }
        for (const item of value) {
            if (typeof item === "string") {
                out.push({ version: item, gameVersion: game, channel: channelOf(item) });
            }
        }
    }
    return out.sort((left, right) => compare(right.version, left.version));
}

// neoforge：{ versions: ["20.2.3-beta", ...] }
function tagged(raw: unknown): LoaderVersion[] {
    const container = object(raw, "neoforge.versions");
    const list = container?.["versions"];
    if (!Array.isArray(list)) {
        return [];
    }
    return list
        .filter((item): item is string => typeof item === "string")
        .map((version) => ({ version, gameVersion: null, channel: channelOf(version) }))
        .sort((left, right) => compare(right.version, left.version));
}

// 版本号按数字段比大小，纯字典序会把 1.9 排到 1.10 后面
function compare(left: string, right: string): number {
    const a = left.split(/[.+-]/);
    const b = right.split(/[.+-]/);
    for (let index = 0; index < Math.max(a.length, b.length); index++) {
        const x = a[index];
        const y = b[index];
        if (x === undefined) {
            return -1;
        }
        if (y === undefined) {
            return 1;
        }
        const nx = Number.parseInt(x, 10);
        const ny = Number.parseInt(y, 10);
        if (Number.isFinite(nx) && Number.isFinite(ny)) {
            if (nx !== ny) {
                return nx - ny;
            }
            continue;
        }
        const order = x.localeCompare(y);
        if (order !== 0) {
            return order;
        }
    }
    return 0;
}

// 版本目录与显示名：不带加载器就是版本号本身，带加载器接在后面
export function defaultVersionName(
    versionId: string,
    loader: LoaderSpec | null,
    loaderVersion: string | null,
): string {
    return loader === null ? versionId : `${versionId}-${loader.name}-${loaderVersion ?? "latest"}`;
}

const FORGE_MAVEN = "https://maven.minecraftforge.net";
const NEOFORGE_MAVEN = "https://maven.neoforged.net";

// forge 与 neoforge 没有 profile json，只能下官方安装器跑一次
// forge 的版本号带游戏版本前缀（1.20.6-50.2.10），只给后半段时补上
export function installerUrlOf(name: LoaderName, game: string, version: string): string | null {
    if (name === "forge") {
        const full = version.startsWith(`${game}-`) ? version : `${game}-${version}`;
        return `${FORGE_MAVEN}/net/minecraftforge/forge/${full}/forge-${full}-installer.jar`;
    }
    if (name === "neoforge") {
        return `${NEOFORGE_MAVEN}/releases/net/neoforged/neoforge/${version}/neoforge-${version}-installer.jar`;
    }
    return null;
}

// quilt 的 meta 与 fabric 同构，只是基址不同；forge 与 neoforge 得走官方安装器
const META_BASE: Partial<Record<LoaderName, string>> = {
    fabric: FABRIC_BASE,
    quilt: QUILT_BASE,
};

export async function resolveLoaderVersion(
    spec: LoaderSpec,
    game: string,
    options: FetchOptions,
): Promise<string> {
    const base = META_BASE[spec.name];
    if (base === undefined) {
        throw new AppError("loader", "NotImplemented", {
            context: { detail: `安装 ${spec.name} 加载器` },
        });
    }
    return spec.version ?? (await latestMeta(base, spec.name, game, options));
}

export async function fetchLoaderProfile(
    spec: LoaderSpec,
    game: string,
    version: string,
    options: FetchOptions,
): Promise<Record<string, unknown>> {
    const base = META_BASE[spec.name];
    if (base === undefined) {
        throw new AppError("loader", "NotImplemented", {
            context: { detail: `安装 ${spec.name} 加载器` },
        });
    }

    const url = `${base}/versions/loader/${encodeURIComponent(game)}/${encodeURIComponent(version)}/profile/json`;
    const raw = object(await fetchJson(url, options), url);
    if (raw === undefined) {
        throw new AppError("loader", "VersionBroken", {
            context: { detail: `${spec.name} ${version} 的 profile 读不出来` },
        });
    }
    return raw;
}

// 列表按新到旧排，优先取 stable
async function latestMeta(
    base: string,
    name: LoaderName,
    game: string,
    options: FetchOptions,
): Promise<string> {
    const url = `${base}/versions/loader/${encodeURIComponent(game)}`;
    const list = await fetchJson(url, options);
    if (!Array.isArray(list)) {
        throw new AppError("loader", "VersionNotFound", {
            context: { detail: `${name} 没有 ${game} 的加载器列表` },
        });
    }

    const versions: { version: string; stable: boolean }[] = [];
    for (const entry of list) {
        const loader = object(
            object(entry, "fabric.loader[]")?.["loader"],
            "fabric.loader[].loader",
        );
        const version = loader?.["version"];
        if (typeof version === "string") {
            versions.push({ version, stable: loader?.["stable"] === true });
        }
    }

    const picked = versions.find((item) => item.stable) ?? versions[0];
    if (picked === undefined) {
        throw new AppError("loader", "VersionNotFound", {
            context: { detail: `${name} 没有 ${game} 的加载器` },
        });
    }
    log.debug("%s %s 选到 %s", name, game, picked.version);
    return picked.version;
}

async function fetchJson(
    url: string,
    options: FetchOptions,
    transport?: Transport,
): Promise<unknown> {
    const buffer = await (transport ?? fetchBuffer)(url, options);
    return parseJson(buffer.toString("utf8"), url);
}
