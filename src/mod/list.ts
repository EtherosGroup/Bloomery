/**
 * 已装 MOD 列表
 *
 * 本地扫 mods/ 下的 jar（含 .jar.disabled），按文件 sha1 反查 Modrinth 补项目名与版本
 * 离线、限流、没发布过的 jar 都退回文件名，单个查不到不影响其余条目
 * 反查分两步：逐个 sha1 取版本，再把去重后的 project_id 一次问一批
 * @author IsCibocaz
 * @since 1.13.0
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { TransferOptions } from "../infra/download.ts";
import {
    projectsOf,
    versionFileOfHash,
    type ModHit,
    type ModrinthInput,
    type ModVersion,
    type Transport,
} from "./modrinth.ts";

/** 算作 MOD 的文件名；禁用态就是加一层 .disabled 后缀 */
export const MOD_FILE = /\.jar(\.disabled)?$/i;

/** 一次问批的项目 id 个数，URL 长度留余量 */
const PROJECT_BATCH = 50;

/** 磁盘上的一个 MOD 文件 */
export interface ScannedMod {
    readonly filename: string;
    readonly path: string;
    readonly size: number;
    readonly enabled: boolean;
}

export interface ModProjectRef {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    /** 中文名；表里没有这个 slug 时为 null */
    readonly titleZh: string | null;
}

export interface ModVersionRef {
    readonly id: string;
    readonly number: string;
    readonly type: string;
}

export interface InstalledMod extends ScannedMod {
    readonly sha1: string | null;
    /** 反查是否拿到项目名；false 时 project 为 null，GUI 退回文件名显示 */
    readonly resolved: boolean;
    readonly project: ModProjectRef | null;
    readonly version: ModVersionRef | null;
}

/** 逐条帧的负载：每反查出一个文件推一条，最终整批结果仍是权威值 */
export interface ModItemEvent {
    readonly key: "mod-item";
    readonly file: string;
    readonly project: ModProjectRef | null;
    readonly version: ModVersionRef | null;
}

export interface ModListInput {
    readonly modsDirectory: string;
    readonly network: TransferOptions;
    readonly offline?: boolean;
    readonly transport?: Transport;
    /** slug → 中文名，反查拿到项目后按 slug 补 titleZh */
    readonly names?: ReadonlyMap<string, string>;
    /** 反查进度：done/total 是文件个数 */
    readonly onResolve?: (done: number, total: number) => void;
    /** 每个文件的项目与版本定下来时调一次，按文件顺序，逐条帧用 */
    readonly onFile?: (item: InstalledMod) => void;
}

// 只认 jar 与 .jar.disabled，目录不存在就是没装过
export async function scanMods(modsDirectory: string): Promise<readonly ScannedMod[]> {
    const entries = await readdir(modsDirectory, { withFileTypes: true }).catch(() => []);
    const mods: ScannedMod[] = [];
    for (const entry of entries) {
        if (!entry.isFile() || !MOD_FILE.test(entry.name)) {
            continue;
        }
        const path = join(modsDirectory, entry.name);
        const size = await stat(path).then(
            (info) => info.size,
            () => 0,
        );
        mods.push({
            filename: entry.name,
            path,
            size,
            enabled: !/\.disabled$/i.test(entry.name),
        });
    }
    return mods.sort((left, right) => left.filename.localeCompare(right.filename));
}

export async function listInstalledMods(input: ModListInput): Promise<readonly InstalledMod[]> {
    const scanned = await scanMods(input.modsDirectory);
    const digests = new Map<string, string | null>();
    for (const mod of scanned) {
        // 顺序算就行，这一步是磁盘带宽说了算
        digests.set(mod.filename, await sha1Of(mod.path));
    }

    const versions = new Map<string, ModVersion>();
    const projects = new Map<string, ModProjectRef>();
    const install = (mod: ScannedMod): InstalledMod =>
        installedOf(mod, digests, versions, projects);
    if (input.offline !== true && scanned.length > 0) {
        const api: ModrinthInput = { network: input.network, transport: input.transport };
        await resolve(
            scanned,
            digests,
            versions,
            projects,
            api,
            input.names,
            input.onResolve,
            input.onFile,
        );
    }

    return scanned.map(install);
}

/* ---------- 内部 ---------- */

function installedOf(
    mod: ScannedMod,
    digests: ReadonlyMap<string, string | null>,
    versions: ReadonlyMap<string, ModVersion>,
    projects: ReadonlyMap<string, ModProjectRef>,
): InstalledMod {
    const version = versions.get(mod.filename);
    const project = version === undefined ? undefined : projects.get(version.projectId);
    return {
        ...mod,
        sha1: digests.get(mod.filename) ?? null,
        resolved: project !== undefined,
        project: project ?? null,
        version:
            version === undefined
                ? null
                : { id: version.id, number: version.versionNumber, type: version.versionType },
    };
}

async function resolve(
    scanned: readonly ScannedMod[],
    digests: ReadonlyMap<string, string | null>,
    versions: Map<string, ModVersion>,
    projects: Map<string, ModProjectRef>,
    api: ModrinthInput,
    names: ReadonlyMap<string, string> | undefined,
    onResolve?: (done: number, total: number) => void,
    onFile?: (item: InstalledMod) => void,
): Promise<void> {
    const total = scanned.length;
    onResolve?.(0, total);
    let done = 0;

    // 项目信息只能批量换，帧按批推；单帧仍带齐 project 与 version
    for (let start = 0; start < total; start += PROJECT_BATCH) {
        const chunk = scanned.slice(start, start + PROJECT_BATCH);
        for (const mod of chunk) {
            const sha1 = digests.get(mod.filename);
            if (sha1 !== null && sha1 !== undefined) {
                // 单个查不到（没发布过、限流、断网）都只是这一条退回文件名
                const version = await versionFileOfHash(sha1, api).catch(() => undefined);
                if (version !== undefined) {
                    versions.set(mod.filename, version);
                }
            }
            done += 1;
            onResolve?.(done, total);
        }

        const ids = [
            ...new Set(
                chunk
                    .map((mod) => versions.get(mod.filename)?.projectId)
                    .filter((id): id is string => id !== undefined && !projects.has(id)),
            ),
        ];
        if (ids.length > 0) {
            const hits = await projectsOf(ids, api).catch(() => [] as readonly ModHit[]);
            for (const hit of hits) {
                projects.set(hit.id, projectRef(hit, names));
            }
        }

        if (onFile !== undefined) {
            for (const mod of chunk) {
                onFile(installedOf(mod, digests, versions, projects));
            }
        }
    }
}

function projectRef(hit: ModHit, names?: ReadonlyMap<string, string>): ModProjectRef {
    return {
        id: hit.id,
        slug: hit.slug,
        title: hit.title,
        titleZh: names?.get(hit.slug) ?? null,
    };
}

export function modItemOf(item: InstalledMod): ModItemEvent {
    return { key: "mod-item", file: item.filename, project: item.project, version: item.version };
}

export async function sha1Of(path: string): Promise<string | null> {
    try {
        const hash = createHash("sha1");
        for await (const chunk of createReadStream(path)) {
            hash.update(chunk as Buffer);
        }
        return hash.digest("hex");
    } catch {
        return null;
    }
}
