/**
 * 版本移除与找回
 *
 * 移除是把 versions/<id> 挪到 <文件夹>/.removed/<id>：文件一个不删，配置与统计原样留着
 * 落点放在 versions/ 之外是有意的：发现只认 versions/ 下的目录，挪走就不再被当实例列出来
 * 配置里那条还在，所以恢复就是把目录挪回来，实例设置与游玩时间一样不丢
 * @author IsCibocaz
 * @since 1.14.0
 */

import { mkdir, readdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { AppError } from "../error/index.ts";
import { pathExists } from "../infra/fs.ts";
import { logger } from "../output/index.ts";

const log = logger("version");

/** 移除的版本落在 <文件夹>/.removed/ 下，与 versions/ 平级 */
export const REMOVED_DIRECTORY = ".removed";

/** 移除后的落点 */
export function removedRoot(folderPath: string): string {
    return join(folderPath, REMOVED_DIRECTORY);
}

export interface RemovedVersion {
    readonly id: string;
    /** <文件夹>/.removed/<id> */
    readonly directory: string;
}

export interface MoveInput {
    readonly folderPath: string;
    readonly id: string;
    readonly dryRun?: boolean | undefined;
}

export interface MoveReport {
    readonly id: string;
    /** 挪动后的落点 */
    readonly directory: string;
    /** 只预览时为 false */
    readonly moved: boolean;
}

export async function removeVersion(input: MoveInput): Promise<MoveReport> {
    return move(input, join(input.folderPath, "versions"), removedRoot(input.folderPath));
}

export async function restoreVersion(input: MoveInput): Promise<MoveReport> {
    return move(input, removedRoot(input.folderPath), join(input.folderPath, "versions"));
}

// 两个方向只差起点与终点：目录不在、落点已被占用都当场报错
async function move(input: MoveInput, fromRoot: string, toRoot: string): Promise<MoveReport> {
    const source = join(fromRoot, input.id);
    const target = join(toRoot, input.id);

    if (!(await pathExists(source))) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: input.id, folder: input.folderPath },
        });
    }
    if (await pathExists(target)) {
        throw new AppError("cli", "VersionExists", { context: { detail: target } });
    }

    if (input.dryRun !== true) {
        await mkdir(toRoot, { recursive: true });
        await rename(source, target);
        log.info("挪动 %s -> %s", source, target);
    }
    return { id: input.id, directory: target, moved: input.dryRun !== true };
}

/** 这个文件夹里被移除过的版本；没有 .removed/ 就是空的 */
export async function listRemoved(folderPath: string): Promise<readonly RemovedVersion[]> {
    const root = removedRoot(folderPath);
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ id: entry.name, directory: join(root, entry.name) }))
        .sort((left, right) => left.id.localeCompare(right.id));
}

/** 某个 id 是不是被移除过；实例发现用它把配置里那条藏起来 */
export async function isRemoved(folderPath: string, id: string): Promise<boolean> {
    return pathExists(join(removedRoot(folderPath), id));
}
