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
    readonly total: number;
    readonly present: number;
    readonly missing: number;
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
export async function countAssets(assetsRoot: string, index: AssetIndex): Promise<AssetStat> {
    const hashes = [...new Set(Object.values(index.objects).map((entry) => entry.hash))];
    const batch = 128;
    let present = 0;

    for (let at = 0; at < hashes.length; at += batch) {
        const slice = hashes.slice(at, at + batch);
        const found = await Promise.all(
            slice.map((hash) => pathExists(assetObjectFile(assetsRoot, hash))),
        );
        present += found.filter(Boolean).length;
    }

    const stat = { total: hashes.length, present, missing: hashes.length - present };
    if (stat.missing > 0) {
        log.warn("资源对象缺 %d 个，共 %d 个", stat.missing, stat.total);
    }
    return stat;
}
