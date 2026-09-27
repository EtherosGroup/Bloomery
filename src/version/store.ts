/**
 * versions/ 目录读取
 *
 * 一个版本一个目录，目录名即实例 id，描述符是目录里的 <id>.json
 * 部分第三方安装器会把 json 改名，先找 <id>.json，再退到目录里唯一的 .json
 * 单个版本读坏不影响其余版本
 * @author IsCibocaz
 * @since 1.0.0
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { logger } from "../output/index.ts";
import { readDescriptor, type Descriptor } from "./descriptor.ts";

const log = logger("version");

export interface LocalVersion {
    readonly id: string;
    /** versions/<id>，隔离后的游戏文件也在这里 */
    readonly directory: string;
    readonly json: string;
    /** <id>.jar 是否存在 */
    readonly jar: boolean;
    readonly descriptor: Descriptor | null;
    readonly problem: string | null;
}

export interface VersionScan {
    /** versions/ */
    readonly directory: string;
    readonly exists: boolean;
    readonly versions: readonly LocalVersion[];
}

export async function scanVersions(root: string): Promise<VersionScan> {
    const directory = join(root, "versions");
    const names = await listDirectories(directory);
    if (names === undefined) {
        return { directory, exists: false, versions: [] };
    }

    const versions: LocalVersion[] = [];
    for (const id of names) {
        versions.push(await readVersion(directory, id));
    }
    return { directory, exists: true, versions };
}

export async function readVersion(versionsDirectory: string, id: string): Promise<LocalVersion> {
    const directory = join(versionsDirectory, id);
    const jar = await exists(join(directory, `${id}.jar`));
    const json = await findJson(directory, id);
    if (json === null) {
        log.warn("%s 里没有版本 json", directory);
        return {
            id,
            directory,
            json: join(directory, `${id}.json`),
            jar,
            descriptor: null,
            problem: "目录里没有版本 json",
        };
    }

    const read = await readDescriptor(json, id);
    return { id, directory, json, jar, descriptor: read.descriptor, problem: read.problem };
}

// 首选 <id>.json，退而取目录里唯一的 .json
async function findJson(directory: string, id: string): Promise<string | null> {
    const preferred = join(directory, `${id}.json`);
    if (await exists(preferred)) {
        return preferred;
    }
    const names = await readdir(directory).catch(() => [] as string[]);
    const candidates = names.filter((name) => name.toLowerCase().endsWith(".json"));
    if (candidates.length !== 1) {
        return null;
    }
    const only = candidates[0];
    return only === undefined ? null : join(directory, only);
}

// 只收目录，按名字排序；目录不在返回 undefined
async function listDirectories(path: string): Promise<string[] | undefined> {
    const entries = await readdir(path, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR") {
                return undefined;
            }
            throw error;
        },
    );
    if (entries === undefined) {
        return undefined;
    }
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}
