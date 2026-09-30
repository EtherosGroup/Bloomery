/**
 * .mrpack 清单
 *
 * Modrinth 的整合包格式：zip 根目录的 modrinth.index.json 描述游戏版本、加载器与要下的文件
 * overrides/ 与 client-overrides/ 是随包的配置，导入时摊到实例目录
 * @author IsCibocaz
 * @since 1.3.0
 */

import { object, parseJson } from "../config/read.ts";
import { AppError } from "../error/index.ts";
import { readZipEntry } from "../infra/zip.ts";
import type { LoaderName, LoaderSpec } from "../version/index.ts";

export const MRPACK_MANIFEST = "modrinth.index.json";

/** 依赖键到本项目的加载器名 */
const LOADERS: Readonly<Record<string, LoaderName>> = {
    "fabric-loader": "fabric",
    "quilt-loader": "quilt",
    forge: "forge",
    neoforge: "neoforge",
};

export interface MrpackFile {
    /** 相对实例目录的落点，例如 mods/sodium.jar */
    readonly path: string;
    readonly url: string | null;
    readonly sha1: string | null;
    readonly size: number | null;
    /** env.client 为 unsupported 时不装 */
    readonly client: boolean;
}

export interface Mrpack {
    readonly name: string | null;
    readonly versionId: string;
    readonly loader: LoaderSpec | null;
    readonly files: readonly MrpackFile[];
}

export async function readMrpack(path: string): Promise<Mrpack> {
    const data = await readZipEntry(path, MRPACK_MANIFEST);
    if (data === undefined) {
        throw new AppError("modpack", "VersionBroken", {
            context: { detail: `${path} 里没有 ${MRPACK_MANIFEST}` },
        });
    }
    return parseMrpack(parseJson(data.toString("utf8"), path), path);
}

export function parseMrpack(raw: unknown, source: string): Mrpack {
    const root = object(raw, source);
    if (root === undefined) {
        throw new AppError("modpack", "VersionBroken", {
            context: { detail: `${source} 不是对象` },
        });
    }

    const dependencies = object(root["dependencies"], `${source}.dependencies`) ?? {};
    const versionId = dependencies["minecraft"];
    if (typeof versionId !== "string" || versionId === "") {
        throw new AppError("modpack", "VersionBroken", {
            context: { detail: `${source} 没写 dependencies.minecraft` },
        });
    }

    const loader = loaderOf(dependencies);
    const files: MrpackFile[] = [];
    for (const entry of Array.isArray(root["files"]) ? root["files"] : []) {
        const file = object(entry, `${source}.files[]`);
        if (file === undefined) {
            continue;
        }
        const path = file["path"];
        if (
            typeof path !== "string" ||
            path === "" ||
            path.startsWith("/") ||
            path.includes("..")
        ) {
            continue;
        }
        const downloads = Array.isArray(file["downloads"])
            ? file["downloads"].filter((item): item is string => typeof item === "string")
            : [];
        const hashes = object(file["hashes"], `${source}.files[].hashes`) ?? {};
        const env = object(file["env"], `${source}.files[].env`) ?? {};

        files.push({
            path,
            url: downloads[0] ?? null,
            sha1: typeof hashes["sha1"] === "string" ? hashes["sha1"] : null,
            size: typeof file["fileSize"] === "number" ? file["fileSize"] : null,
            client: env["client"] !== "unsupported",
        });
    }

    return {
        name: typeof root["name"] === "string" && root["name"] !== "" ? root["name"] : null,
        versionId,
        loader,
        files,
    };
}

// 依赖里出现哪个加载器就用哪个，另带版本号
function loaderOf(dependencies: Record<string, unknown>): LoaderSpec | null {
    for (const [key, version] of Object.entries(dependencies)) {
        const name = LOADERS[key];
        if (name !== undefined && typeof version === "string" && version !== "") {
            return { name, version };
        }
    }
    return null;
}
