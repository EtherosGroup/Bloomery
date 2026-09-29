/**
 * Modrinth API
 *
 * 搜索、项目与版本都走 v2 公开接口，不需要凭据
 * 版本过滤交给服务端，选出哪一版由 pickVersion 决定
 * 传输层可注入，测试里回放假响应
 * @author IsCibocaz
 * @since 1.1.6
 */

import { object, parseJson } from "../config/read.ts";
import { AppError } from "../error/index.ts";
import { fetchBuffer, type FetchOptions } from "../infra/download.ts";

export const MODRINTH_API = "https://api.modrinth.com/v2";

export type Transport = (url: string, options: FetchOptions) => Promise<Buffer>;

export interface ModrinthInput {
    readonly network: FetchOptions;
    readonly transport?: Transport;
}

export interface ModHit {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly description: string;
    readonly downloads: number;
    readonly loaders: readonly string[];
    readonly gameVersions: readonly string[];
    readonly categories: readonly string[];
}

export interface ModFile {
    readonly url: string;
    readonly filename: string;
    readonly size: number;
    readonly sha1: string | null;
}

/** 依赖：required 要装，其余只提示 */
export interface ModDependency {
    readonly projectId: string | null;
    readonly versionId: string | null;
    readonly type: string;
}

export interface ModVersion {
    readonly id: string;
    readonly projectId: string;
    readonly name: string;
    readonly versionNumber: string;
    readonly versionType: string;
    readonly gameVersions: readonly string[];
    readonly loaders: readonly string[];
    readonly published: string;
    readonly file: ModFile | null;
    readonly dependencies: readonly ModDependency[];
}

export interface VersionFilter {
    /** 不传就不过滤游戏版本 */
    readonly gameVersion?: string | null;
    /** fabric / forge / neoforge / quilt */
    readonly loader?: string | null;
    readonly limit?: number;
}

export const SEARCH_LIMIT = 10;

export async function searchMods(
    query: string,
    input: ModrinthInput & { readonly limit?: number },
): Promise<readonly ModHit[]> {
    const facets = encodeURIComponent(JSON.stringify([["project_type:mod"]]));
    const limit = input.limit ?? SEARCH_LIMIT;
    const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query)}&limit=${limit}&facets=${facets}`;
    const body = (await get(url, input)) ?? {};
    const hits = array(body["hits"]);
    return hits.map((hit) => hitOf(record(hit))).filter((hit): hit is ModHit => hit !== undefined);
}

// 按 id 或 slug 取项目，404 返回 undefined 交给调用方回退到搜索
export async function projectOf(
    idOrSlug: string,
    input: ModrinthInput,
): Promise<ModHit | undefined> {
    const url = `${MODRINTH_API}/project/${encodeURIComponent(idOrSlug)}`;
    const body = await get(url, input, true);
    return body === undefined ? undefined : hitOf(body);
}

export async function listVersions(
    project: string,
    filter: VersionFilter,
    input: ModrinthInput,
): Promise<readonly ModVersion[]> {
    const params: string[] = [];
    if (filter.loader !== null && filter.loader !== undefined) {
        params.push(`loaders=${encodeURIComponent(JSON.stringify([filter.loader]))}`);
    }
    if (filter.gameVersion !== null && filter.gameVersion !== undefined) {
        params.push(`game_versions=${encodeURIComponent(JSON.stringify([filter.gameVersion]))}`);
    }
    const query = params.length === 0 ? "" : `?${params.join("&")}`;
    const url = `${MODRINTH_API}/project/${encodeURIComponent(project)}/version${query}`;
    const body = (await raw(url, input)) ?? [];
    return array(body)
        .map((entry) => versionOf(record(entry)))
        .filter((version): version is ModVersion => version !== undefined);
}

export async function versionOfId(
    id: string,
    input: ModrinthInput,
): Promise<ModVersion | undefined> {
    const url = `${MODRINTH_API}/version/${encodeURIComponent(id)}`;
    const body = await get(url, input, true);
    return body === undefined ? undefined : versionOf(body);
}

// 正式版优先，其次 beta 与 alpha，同级取发布最晚的
export function pickVersion(versions: readonly ModVersion[]): ModVersion | undefined {
    const rank: Record<string, number> = { release: 0, beta: 1, alpha: 2 };
    return [...versions].sort((left, right) => {
        const order = (rank[left.versionType] ?? 3) - (rank[right.versionType] ?? 3);
        return order !== 0 ? order : right.published.localeCompare(left.published);
    })[0];
}

/* ---------- 内部 ---------- */

async function raw(url: string, input: ModrinthInput, optional = false): Promise<unknown> {
    const transport = input.transport ?? fetchBuffer;
    let buffer: Buffer;
    try {
        buffer = await transport(url, input.network);
    } catch (error) {
        const status = statusOf(error);
        if (optional && status === 404) {
            return undefined;
        }
        throw new AppError("mod", "ModNotFound", {
            cause: error,
            context: {
                detail: status === 404 ? url : `请求 Modrinth 失败：${url}`,
                status: status ?? 0,
            },
        });
    }
    return parseJson(buffer.toString("utf8"), url);
}

// 接口多数回对象
async function get(
    url: string,
    input: ModrinthInput,
    optional = false,
): Promise<Record<string, unknown> | undefined> {
    const body = await raw(url, input, optional);
    return body === undefined ? undefined : object(body, url);
}

// fetchBuffer 会把 HttpStatusError 包在 cause 里，状态码要顺着链找
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

function hitOf(raw: Record<string, unknown>): ModHit | undefined {
    const id = field(raw, "project_id") ?? field(raw, "id");
    const slug = field(raw, "slug");
    const title = field(raw, "title");
    if (id === undefined || slug === undefined || title === undefined) {
        return undefined;
    }
    return {
        id,
        slug,
        title,
        description: field(raw, "description") ?? "",
        downloads: number(raw, "downloads") ?? 0,
        loaders: loadersOf(raw),
        gameVersions: strings(raw["versions"] ?? raw["game_versions"]),
        categories: strings(raw["categories"]),
    };
}

function versionOf(raw: Record<string, unknown>): ModVersion | undefined {
    const id = field(raw, "id");
    const projectId = field(raw, "project_id");
    const versionNumber = field(raw, "version_number");
    if (id === undefined || projectId === undefined || versionNumber === undefined) {
        return undefined;
    }

    const primary =
        array(raw["files"])
            .map((entry) => record(entry))
            .find((file) => file["primary"] === true) ?? array(raw["files"]).map(record)[0];

    return {
        id,
        projectId,
        name: field(raw, "name") ?? versionNumber,
        versionNumber,
        versionType: field(raw, "version_type") ?? "release",
        gameVersions: strings(raw["game_versions"]),
        loaders: loadersOf(raw),
        published: field(raw, "date_published") ?? "",
        file: fileOf(primary),
        dependencies: array(raw["dependencies"])
            .map((entry) => dependencyOf(record(entry)))
            .filter((dep): dep is ModDependency => dep !== undefined),
    };
}

function fileOf(raw: Record<string, unknown> | undefined): ModFile | null {
    if (raw === undefined) {
        return null;
    }
    const url = field(raw, "url");
    const filename = field(raw, "filename");
    if (url === undefined || filename === undefined) {
        return null;
    }
    return {
        url,
        filename,
        size: number(raw, "size") ?? 0,
        sha1: field(record(raw["hashes"]), "sha1") ?? null,
    };
}

function dependencyOf(raw: Record<string, unknown>): ModDependency | undefined {
    const type = field(raw, "dependency_type");
    if (type === undefined) {
        return undefined;
    }
    return {
        projectId: field(raw, "project_id") ?? null,
        versionId: field(raw, "version_id") ?? null,
        type,
    };
}

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function array(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
}

function field(container: Record<string, unknown>, key: string): string | undefined {
    const value = container[key];
    return typeof value === "string" && value !== "" ? value : undefined;
}

function number(container: Record<string, unknown>, key: string): number | undefined {
    const value = container[key];
    return typeof value === "number" ? value : undefined;
}

// 搜索命中没有独立的 loaders 字段，加载器混在 categories 里
const LOADER_NAMES = ["fabric", "forge", "neoforge", "quilt", "liteloader", "rift"];

function loadersOf(raw: Record<string, unknown>): string[] {
    const direct = strings(raw["loaders"]);
    return direct.length > 0
        ? direct
        : strings(raw["categories"]).filter((name) => LOADER_NAMES.includes(name));
}

function strings(value: unknown): string[] {
    return array(value).filter((entry): entry is string => typeof entry === "string");
}
