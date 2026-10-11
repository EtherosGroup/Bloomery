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

export interface ModListInput {
    readonly modsDirectory: string;
    readonly network: TransferOptions;
    readonly offline?: boolean;
    readonly transport?: Transport;
    /** 反查进度：done/total 是文件个数 */
    readonly onResolve?: (done: number, total: number) => void;
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
    if (input.offline !== true && scanned.length > 0) {
        const api: ModrinthInput = { network: input.network, transport: input.transport };
        await resolve(scanned, digests, versions, projects, api, input.onResolve);
    }

    return scanned.map((mod) => {
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
    });
}

/* ---------- 内部 ---------- */

async function resolve(
    scanned: readonly ScannedMod[],
    digests: ReadonlyMap<string, string | null>,
    versions: Map<string, ModVersion>,
    projects: Map<string, ModProjectRef>,
    api: ModrinthInput,
    onResolve?: (done: number, total: number) => void,
): Promise<void> {
    const total = scanned.length;
    onResolve?.(0, total);
    let done = 0;
    for (const mod of scanned) {
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

    const ids = [...new Set([...versions.values()].map((version) => version.projectId))];
    for (let index = 0; index < ids.length; index += PROJECT_BATCH) {
        const slice = ids.slice(index, index + PROJECT_BATCH);
        const hits = await projectsOf(slice, api).catch(() => [] as readonly ModHit[]);
        for (const hit of hits) {
            projects.set(hit.id, { id: hit.id, slug: hit.slug, title: hit.title });
        }
    }
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
