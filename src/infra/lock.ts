/**
 * 文件锁
 *
 * wx 独占创建，内容写 pid：持有者已死或内容读不出来时清掉重抢
 * 等到 timeoutMs 仍拿不到就照跑，互斥是尽力而为
 * @author IsCibocaz
 * @since 1.12.0
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { readText } from "./fs.ts";

/** 重试间隔 */
const RETRY_MS = 20;

/** 默认等待上限 */
const DEFAULT_TIMEOUT_MS = 2000;

/** 循环上限，避免在异常文件系统上无限重试 */
const MAX_ATTEMPTS = 500;

export interface FileLockOptions {
    readonly timeoutMs?: number;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

async function create(path: string, pid: number): Promise<boolean> {
    try {
        await writeFile(path, `${pid}\n`, { flag: "wx" });
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
        }
        throw error;
    }
}

async function holder(path: string): Promise<number | null> {
    const text = await readText(path);
    if (text === undefined) {
        return null;
    }
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** 锁里只包一次读加一次写，等不到照跑 */
export async function withFileLock<T>(
    path: string,
    run: () => Promise<T>,
    options: FileLockOptions = {},
): Promise<T> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    await mkdir(dirname(path), { recursive: true });

    let acquired = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        acquired = await create(path, process.pid);
        if (acquired) {
            break;
        }
        const pid = await holder(path);
        if (pid === null || !alive(pid)) {
            await rm(path, { force: true });
            continue;
        }
        if (Date.now() >= deadline) {
            break;
        }
        await sleep(RETRY_MS);
    }

    try {
        return await run();
    } finally {
        if (acquired) {
            await rm(path, { force: true });
        }
    }
}
