/*
 * 文件系统原语
 *
 * 路径拼接不在这里，那属于 platform/path.ts
 * 只放跨模块复用的：原子写、宽松读、权限收紧、留备份
 */

import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// 先写临时文件再改名：目标路径上不会出现写到一半的内容
export async function writeAtomic(path: string, text: string, mode?: number): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.tmp-${process.pid}`;
    try {
        await writeFile(temp, text, mode === undefined ? undefined : { mode });
        await rename(temp, path);
    } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

// 文件不存在返回 undefined，其余错误照抛
export async function readText(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

// 把权限收紧到 mode，已经够紧就不动；Windows 上 POSIX 位基本无效
export async function restrictMode(path: string, mode: number): Promise<void> {
    const info = await stat(path).catch(() => undefined);
    if (info === undefined || (info.mode & 0o777) === mode) {
        return;
    }
    await chmod(path, mode);
}

// 留一份副本，move 为 true 时把原文件挪走；原文件不在返回 undefined
export async function backupFile(path: string, move = false): Promise<string | undefined> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const target = `${path}.bad-${stamp}`;
    try {
        if (move) {
            await rename(path, target);
        } else {
            await copyFile(path, target);
        }
        return target;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
