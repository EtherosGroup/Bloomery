/**
 * 下载
 *
 * 已存在的文件直接跳过，不重算哈希：整目录校验交给别的入口，这里只保证新下的对
 * 先写 .part 再改名，中途失败不会留下半个文件
 * 一个源失败换下一个，全部失败才报错
 * @author IsCibocaz
 * @since 1.0.0
 */

import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { logger } from "../output/index.ts";
import { AppError } from "../error/index.ts";
import { pathExists } from "./fs.ts";
import { httpGet, httpGetBuffer, retryable, sleep, type NetworkOptions } from "./http.ts";
import type { Source } from "./source.ts";

const log = logger("download");

export interface DownloadTask {
    readonly url: string;
    readonly target: string;
    readonly sha1: string | null;
    readonly size: number | null;
}

export interface TransferOptions extends FetchOptions {
    readonly verify: "strict" | "warn" | "off";
    readonly concurrency: number;
}

export interface FetchOptions extends NetworkOptions {
    readonly sources: readonly Source[];
}

export interface DownloadOutcome {
    readonly target: string;
    readonly bytes: number;
    readonly status: "downloaded" | "skipped";
}

export interface DownloadFailure {
    readonly target: string;
    readonly error: string;
}

export interface DownloadReport {
    readonly downloaded: number;
    readonly skipped: number;
    readonly bytes: number;
    readonly failures: readonly DownloadFailure[];
}

export interface Progress {
    (done: number, total: number, target: string): void;
}

export async function downloadOne(
    task: DownloadTask,
    options: TransferOptions,
): Promise<DownloadOutcome> {
    if (await pathExists(task.target)) {
        return { target: task.target, bytes: 0, status: "skipped" };
    }

    await mkdir(dirname(task.target), { recursive: true });
    const temp = `${task.target}.part-${process.pid}`;
    try {
        const bytes = await transfer(task, options, temp);
        await rename(temp, task.target);
        return { target: task.target, bytes, status: "downloaded" };
    } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
    }
}

export async function downloadAll(
    tasks: readonly DownloadTask[],
    options: TransferOptions,
    onProgress?: Progress,
): Promise<DownloadReport> {
    const queue = [...tasks];
    const failures: DownloadFailure[] = [];
    let downloaded = 0;
    let skipped = 0;
    let bytes = 0;
    let done = 0;

    const workers = Math.max(1, Math.min(options.concurrency, queue.length));
    await Promise.all(
        Array.from({ length: workers }, async () => {
            for (;;) {
                const task = queue.shift();
                if (task === undefined) {
                    return;
                }
                try {
                    const outcome = await downloadOne(task, options);
                    if (outcome.status === "skipped") {
                        skipped++;
                    } else {
                        downloaded++;
                        bytes += outcome.bytes;
                    }
                } catch (error) {
                    failures.push({ target: task.target, error: message(error) });
                }
                done++;
                onProgress?.(done, tasks.length, task.target);
            }
        }),
    );

    return { downloaded, skipped, bytes, failures };
}

// 依次试每个源，拿回整个响应体
export async function fetchBuffer(url: string, options: FetchOptions): Promise<Buffer> {
    let last: unknown;
    for (const source of options.sources) {
        try {
            return await httpGetBuffer(source.rewrite(url), options);
        } catch (error) {
            last = error;
            log.debug("%s 从 %s 取失败：%s", url, source.provider, message(error));
        }
    }
    throw new AppError("download", "DownloadFailed", {
        cause: last,
        context: { detail: url },
    });
}

// 依次试每个源，边写边算 sha1；单个源内部再按重试次数重来，卡在正文中间也算一次失败
async function transfer(
    task: DownloadTask,
    options: TransferOptions,
    temp: string,
): Promise<number> {
    let last: unknown;
    const attempts = Math.max(0, options.retries) + 1;

    for (const source of options.sources) {
        const url = source.rewrite(task.url);

        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await once(task, url, options, temp);
            } catch (error) {
                last = error;
                log.debug(
                    "%s 从 %s 取失败（第 %d 次）：%s",
                    task.target,
                    source.provider,
                    attempt,
                    message(error),
                );
                await rm(temp, { force: true }).catch(() => {});
                if (!retryable(error)) {
                    break;
                }
                if (attempt < attempts) {
                    await sleep(300 * attempt);
                }
            }
        }
    }

    throw last instanceof Error ? last : new Error(String(last));
}

async function once(
    task: DownloadTask,
    url: string,
    options: TransferOptions,
    temp: string,
): Promise<number> {
    const response = await httpGet(url, options);
    const hash = createHash("sha1");
    let bytes = 0;

    await pipeline(
        response.stream,
        new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                hash.update(chunk);
                bytes += chunk.length;
                callback(null, chunk);
            },
        }),
        createWriteStream(temp),
    );

    check(task, hash.digest("hex"), options.verify);
    return bytes;
}

function check(task: DownloadTask, digest: string, verify: TransferOptions["verify"]): void {
    if (verify === "off" || task.sha1 === null) {
        return;
    }
    if (digest === task.sha1) {
        return;
    }
    const complaint = `sha1 不符：${task.target} 期望 ${task.sha1} 实得 ${digest}`;
    if (verify === "strict") {
        throw new Error(complaint);
    }
    log.warn("%s", complaint);
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
