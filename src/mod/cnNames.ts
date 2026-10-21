/**
 * MOD 中文名表
 *
 * 表由仓库生成，一行 slug 与中文名，TAB 分隔；也认 PCL 那套 | 分隔，仅用于本地核对
 * 缓存在配置目录的 metadata/ 下，24h 内不重复请求；条件请求带 ETag 与 Last-Modified，304 沿用本地
 * 网络失败、文件损坏都沿用上一份缓存，没有缓存就是空表，调用方一律拿 null
 * @author IsCibocaz
 * @since 1.15.0
 */

import { readFile } from "node:fs/promises";

import type { FetchOptions } from "../infra/download.ts";
import { writeAtomic } from "../infra/fs.ts";
import { httpGetResponse, type BufferResponse, type NetworkOptions } from "../infra/http.ts";
import { logger } from "../output/index.ts";
import { cnNamesFile, cnNamesMetaFile } from "../platform/index.ts";

const log = logger("mod");

/** 缓存有效期，命中就不联网 */
export const CN_NAMES_TTL_MS = 24 * 60 * 60 * 1000;

/** 拉表超时上限 */
export const CN_NAMES_TIMEOUT_MS = 3000;

/** 表地址，依次尝试；环境变量给一个就只认它 */
export const CN_NAMES_URLS: readonly string[] = [
    "https://cdn.jsdelivr.net/gh/EtherosGroup/Bloomery@master/metadata/cn-names.tsv",
    "https://raw.githubusercontent.com/EtherosGroup/Bloomery/master/metadata/cn-names.tsv",
];

/** 缓存状态，字段都来自上次成功或失败的请求 */
interface NamesMeta {
    readonly url: string;
    readonly etag: string | null;
    readonly lastModified: string | null;
    /** 表内容的更新时间；没成功拉过就是 null */
    readonly updatedAt: string | null;
    /** 上次检查时间，TTL 按它算 */
    readonly checkedAt: string;
}

interface Cached {
    readonly text: string;
    readonly meta: NamesMeta | null;
}

export interface CnNamesInfo {
    readonly path: string;
    readonly source: string;
    readonly updatedAt: string | null;
    readonly count: number;
}

export interface CnNames {
    /** slug → 中文名 */
    readonly names: ReadonlyMap<string, string>;
    readonly info: CnNamesInfo;
}

export type NamesTransport = (url: string, options: NetworkOptions) => Promise<BufferResponse>;

export interface CnNamesInput {
    readonly network: FetchOptions;
    /** 不联网，只读本地缓存 */
    readonly offline?: boolean;
    /** 跳过 TTL 与条件请求，直接重下 */
    readonly refresh?: boolean;
    readonly transport?: NamesTransport;
    /** 测试用时钟，返回毫秒时间戳 */
    readonly now?: () => number;
}

/** 有没有可用的中文名表：只把本地扫一遍，不联网 */
export async function loadCnNames(input: CnNamesInput): Promise<CnNames> {
    const cached = await readCache();
    const now = input.now?.() ?? Date.now();
    if (
        input.offline === true ||
        (input.refresh !== true && cached.meta !== null && fresh(cached.meta, now))
    ) {
        return tableOf(cached.text, cached.meta);
    }

    const refreshed = await refresh(cached, input, now);
    return tableOf(refreshed.text, refreshed.meta);
}

/** 解析表：TAB 优先，没有 TAB 再按 |，坏行直接跳过 */
export function parseCnNames(text: string): ReadonlyMap<string, string> {
    const names = new Map<string, string>();
    for (const raw of text.replace(/^\uFEFF/, "").split("\n")) {
        const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
        if (line === "" || line.startsWith("#")) {
            continue;
        }
        const tab = line.indexOf("\t");
        const separator = tab >= 0 ? "\t" : "|";
        const at = tab >= 0 ? tab : line.indexOf("|");
        if (at < 0) {
            continue;
        }
        const slug = line.slice(0, at).trim();
        const rest = line.slice(at + 1);
        const next = rest.indexOf(separator);
        const name = (next < 0 ? rest : rest.slice(0, next)).trim();
        if (slug === "" || name === "") {
            continue;
        }
        if (!names.has(slug)) {
            names.set(slug, name);
        }
    }
    return names;
}

/** 表地址：环境变量优先，便于本地与 GUI 联调 */
export function cnNamesUrls(): readonly string[] {
    const override = process.env["BLOOMERY_CN_NAMES_URL"]?.trim();
    return override === undefined || override === "" ? CN_NAMES_URLS : [override];
}

/* ---------- 内部 ---------- */

function tableOf(text: string, meta: NamesMeta | null): CnNames {
    const names = parseCnNames(text);
    return {
        names,
        info: {
            path: cnNamesFile(),
            source: meta?.url ?? cnNamesUrls()[0] ?? "",
            updatedAt: meta?.updatedAt ?? null,
            count: names.size,
        },
    };
}

function fresh(meta: NamesMeta, now: number): boolean {
    const checked = Date.parse(meta.checkedAt);
    return Number.isFinite(checked) && now - checked < CN_NAMES_TTL_MS;
}

async function refresh(cached: Cached, input: CnNamesInput, now: number): Promise<Cached> {
    const transport = input.transport ?? httpGetResponse;
    const time = new Date(now).toISOString();
    for (const url of cnNamesUrls()) {
        const conditional = cached.meta?.url === url ? cached.meta : null;
        const headers: Record<string, string> = { ...input.network.headers };
        if (conditional?.etag !== null && conditional?.etag !== undefined) {
            headers["if-none-match"] = conditional.etag;
        }
        if (conditional?.lastModified !== null && conditional?.lastModified !== undefined) {
            headers["if-modified-since"] = conditional.lastModified;
        }

        let response: BufferResponse;
        try {
            response = await transport(url, {
                ...input.network,
                headers,
                // 拉表用独立的超时与重试，不与主流程共用
                timeoutMs: Math.min(input.network.timeoutMs, CN_NAMES_TIMEOUT_MS),
                retries: 0,
            });
        } catch (error) {
            log.debug("中文名表请求失败 %s：%s", url, messageOf(error));
            continue;
        }

        if (response.status === 304 && conditional !== null) {
            const meta: NamesMeta = { ...conditional, checkedAt: time };
            await saveMeta(meta);
            return { text: cached.text, meta };
        }
        if (response.status !== 200) {
            log.debug("中文名表状态码 %d：%s", response.status, url);
            continue;
        }

        const text = response.body.toString("utf8");
        if (parseCnNames(text).size === 0) {
            log.debug("中文名表为空：%s", url);
            continue;
        }

        const meta: NamesMeta = {
            url,
            etag: headerOf(response, "etag"),
            lastModified: headerOf(response, "last-modified"),
            updatedAt: time,
            checkedAt: time,
        };
        await saveTable(text);
        await saveMeta(meta);
        return { text, meta };
    }

    // 全部源都失败：只推进检查时间，缓存与更新时间不动
    const meta: NamesMeta =
        cached.meta === null
            ? {
                  url: cnNamesUrls()[0] ?? "",
                  etag: null,
                  lastModified: null,
                  updatedAt: null,
                  checkedAt: time,
              }
            : { ...cached.meta, checkedAt: time };
    await saveMeta(meta);
    return { text: cached.text, meta };
}

function headerOf(response: BufferResponse, name: string): string | null {
    const value = response.headers[name];
    if (Array.isArray(value)) {
        return value[0] ?? null;
    }
    return value ?? null;
}

async function readCache(): Promise<Cached> {
    const text = await readFile(cnNamesFile(), "utf8").catch(() => null);
    if (text === null) {
        return { text: "", meta: null };
    }
    const raw = await readFile(cnNamesMetaFile(), "utf8").catch(() => null);
    return { text, meta: raw === null ? null : metaOf(raw) };
}

function metaOf(raw: string): NamesMeta | null {
    try {
        const value = JSON.parse(raw) as Record<string, unknown>;
        const url = value["url"];
        const checkedAt = value["checkedAt"];
        if (typeof url !== "string" || typeof checkedAt !== "string") {
            return null;
        }
        return {
            url,
            checkedAt,
            etag: stringOrNull(value["etag"]),
            lastModified: stringOrNull(value["lastModified"]),
            updatedAt: stringOrNull(value["updatedAt"]),
        };
    } catch {
        return null;
    }
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" && value !== "" ? value : null;
}

async function saveTable(text: string): Promise<void> {
    await writeAtomic(cnNamesFile(), text).catch((error: unknown) => {
        log.debug("中文名表落盘失败：%s", messageOf(error));
    });
}

async function saveMeta(meta: NamesMeta): Promise<void> {
    await writeAtomic(cnNamesMetaFile(), `${JSON.stringify(meta, null, 4)}\n`).catch(
        (error: unknown) => {
            log.debug("中文名表状态落盘失败：%s", messageOf(error));
        },
    );
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
