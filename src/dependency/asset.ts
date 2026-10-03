/**
 * 资源索引
 *
 * 只读与统计，下载留给 install
 * @author IsCibocaz
 * @since 1.0.0
 */

import { join } from "node:path";

import { object, parseJson } from "../config/read.ts";
import { pathExists, readText } from "../infra/fs.ts";
import { logger } from "../output/index.ts";

const log = logger("dependency");

export interface AssetObject {
    readonly hash: string;
    readonly size: number;
}

export interface AssetIndex {
    readonly id: string;
    readonly objects: Readonly<Record<string, AssetObject>>;
    /** 1.7 以前的索引：对象要另铺一份到 assets/virtual/<id>/ */
    readonly virtual: boolean;
    readonly mapToResources: boolean;
}

export interface AssetStat {
    /** 索引 id */
    readonly index: string;
    /** 索引里的对象数；索引不在本地时为 null */
    readonly total: number | null;
    /** 本地已有的对象数 */
    readonly present: number;
    /** 缺的对象数；索引不在本地时为 null */
    readonly missing: number | null;
    /** 要下的字节数，索引不在本地时含索引自身；大小未知时为 null */
    readonly size: number | null;
}

export function assetIndexFile(assetsRoot: string, id: string): string {
    return join(assetsRoot, "indexes", `${id}.json`);
}

export function assetObjectFile(assetsRoot: string, hash: string): string {
    return join(assetsRoot, "objects", hash.slice(0, 2), hash);
}

export async function readAssetIndex(assetsRoot: string, id: string): Promise<AssetIndex | null> {
    const path = assetIndexFile(assetsRoot, id);
    const text = await readText(path);
    if (text === undefined) {
        return null;
    }
    const raw = object(parseJson(text, path), path);
    if (raw === undefined) {
        return null;
    }

    const objects: Record<string, AssetObject> = {};
    const source = raw["objects"];
    if (typeof source === "object" && source !== null && !Array.isArray(source)) {
        for (const [name, value] of Object.entries(source)) {
            const entry = object(value, `${path}.objects.${name}`);
            const hash = entry?.["hash"];
            if (typeof hash === "string") {
                const size = entry?.["size"];
                objects[name] = { hash, size: typeof size === "number" ? size : 0 };
            }
        }
    }

    const id_ = raw["id"];
    return {
        id: typeof id_ === "string" ? id_ : id,
        objects,
        virtual: raw["virtual"] === true,
        mapToResources: raw["map_to_resources"] === true,
    };
}

// 按批并发，几万个 stat 不堆在一起
// size 只累加缺失的那部分：同一个哈希可能挂在多个名字下，先按哈希去重
export async function countAssets(assetsRoot: string, index: AssetIndex): Promise<AssetStat> {
    const objects = new Map<string, number>();
    for (const entry of Object.values(index.objects)) {
        objects.set(entry.hash, entry.size);
    }
    const hashes = [...objects.keys()];
    const batch = 128;
    let present = 0;
    let size = 0;

    for (let at = 0; at < hashes.length; at += batch) {
        const slice = hashes.slice(at, at + batch);
        const found = await Promise.all(
            slice.map((hash) => pathExists(assetObjectFile(assetsRoot, hash))),
        );
        found.forEach((exists, offset) => {
            if (exists) {
                present++;
                return;
            }
            size += objects.get(slice[offset] ?? "") ?? 0;
        });
    }

    const total = hashes.length;
    const missing = total - present;
    if (missing > 0) {
        log.warn("资源对象缺 %d 个，共 %d 个", missing, total);
    }
    return { index: index.id, total, present, missing, size };
}
