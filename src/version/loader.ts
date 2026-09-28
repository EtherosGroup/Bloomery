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

export type LoaderName = "fabric" | "forge" | "neoforge" | "quilt";

const NAMES: readonly LoaderName[] = ["fabric", "forge", "neoforge", "quilt"];

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

async function fetchJson(url: string, options: FetchOptions): Promise<unknown> {
    const buffer = await fetchBuffer(url, options);
    return parseJson(buffer.toString("utf8"), url);
}
