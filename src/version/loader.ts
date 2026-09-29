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

const FABRIC_META = "https://meta.fabricmc.net/v2/versions/loader";

// 各家加载器的版本清单，形状各不相同，见下面的解析
const LOADER_LISTS: Record<LoaderName, string> = {
    fabric: "https://meta.fabricmc.net/v2/versions/loader",
    quilt: "https://meta.quiltmc.org/v3/versions/loader",
    forge: "https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json",
    neoforge: "https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge",
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

export async function resolveLoaderVersion(
    spec: LoaderSpec,
    game: string,
    options: FetchOptions,
): Promise<string> {
    if (spec.name !== "fabric") {
        throw new AppError("loader", "NotImplemented", {
            context: { detail: `安装 ${spec.name} 加载器` },
        });
    }
    return spec.version ?? (await latestFabric(game, options));
}

export async function fetchLoaderProfile(
    spec: LoaderSpec,
    game: string,
    version: string,
    options: FetchOptions,
): Promise<Record<string, unknown>> {
    if (spec.name !== "fabric") {
        throw new AppError("loader", "NotImplemented", {
            context: { detail: `安装 ${spec.name} 加载器` },
        });
    }

    const url = `${FABRIC_META}/${encodeURIComponent(game)}/${encodeURIComponent(version)}/profile/json`;
    const raw = object(await fetchJson(url, options), url);
    if (raw === undefined) {
        throw new AppError("loader", "VersionBroken", {
            context: { detail: `Fabric ${version} 的 profile 读不出来` },
        });
    }
    return raw;
}

// 列表按新到旧排，优先取 stable
async function latestFabric(game: string, options: FetchOptions): Promise<string> {
    const url = `${FABRIC_META}/${encodeURIComponent(game)}`;
    const list = await fetchJson(url, options);
    if (!Array.isArray(list)) {
        throw new AppError("loader", "VersionNotFound", {
            context: { detail: `Fabric 没有 ${game} 的加载器列表` },
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
            context: { detail: `Fabric 没有 ${game} 的加载器` },
        });
    }
    log.debug("fabric %s 选到 %s", game, picked.version);
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
