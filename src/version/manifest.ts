/**
 * 版本清单
 *
 * version_manifest_v2.json 列出所有可下载的版本与各自的 json 地址
 * 只在本地没有版本 json 时才用到它
 * @author IsCibocaz
 * @since 1.0.0
 */

import { object, parseJson } from "../config/read.ts";
import { fetchBuffer, type FetchOptions } from "../infra/download.ts";
import type { VersionType } from "./descriptor.ts";

export const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";

const TYPES = ["release", "snapshot", "old_beta", "old_alpha"] as const;

export interface ManifestVersion {
    readonly id: string;
    readonly type: VersionType;
    readonly url: string;
    readonly sha1: string | null;
    readonly releaseTime: string | null;
}

export interface Manifest {
    readonly latest: { readonly release: string | null; readonly snapshot: string | null };
    readonly versions: readonly ManifestVersion[];
}

export async function fetchManifest(options: FetchOptions): Promise<Manifest> {
    const buffer = await fetchBuffer(MANIFEST_URL, options);
    const text = buffer.toString("utf8");
    const raw = object(parseJson(text, MANIFEST_URL), MANIFEST_URL);
    if (raw === undefined) {
        throw new Error(`${MANIFEST_URL} 不是对象`);
    }

    const versions: ManifestVersion[] = [];
    const list = raw["versions"];
    if (Array.isArray(list)) {
        for (const value of list) {
            const entry = object(value, "manifest.versions[]");
            const id = entry?.["id"];
            const url = entry?.["url"];
            if (typeof id !== "string" || typeof url !== "string") {
                continue;
            }
            const type = entry?.["type"];
            versions.push({
                id,
                url,
                type:
                    typeof type === "string" && (TYPES as readonly string[]).includes(type)
                        ? (type as VersionType)
                        : "release",
                sha1: stringOrNull(entry?.["sha1"]),
                releaseTime: stringOrNull(entry?.["releaseTime"]),
            });
        }
    }

    const latest = object(raw["latest"], "manifest.latest");
    return {
        latest: {
            release: stringOrNull(latest?.["release"]),
            snapshot: stringOrNull(latest?.["snapshot"]),
        },
        versions,
    };
}

export function findVersion(manifest: Manifest, id: string): ManifestVersion | undefined {
    return manifest.versions.find((version) => version.id === id);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === "string" ? value : null;
}
