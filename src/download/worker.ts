/**
 * 队列 worker：一次一个 pending 任务
 *
 * 启动先抢 pid 锁，已有存活 worker 时拒绝
 * 上一次留下的 running 任务先标 failed，再从头找 pending
 * 任务内部沿用各自的下载逻辑，进度节流写回队列文件
 * @author IsCibocaz
 * @since 1.11.0
 */

import { logger } from "../output/index.ts";
import { downloadCancelFile, downloadLockFile, downloadQueueFile } from "../platform/index.ts";
import {
    acquireLock,
    clearCancelRequest,
    patchTask,
    progressThrottle,
    readCancelRequests,
    readQueue,
    recoverRunning,
    stamp,
    taskErrorOf,
    TaskCancelled,
    type DownloadTask,
    type TaskError,
    type TaskProgress,
} from "./queue.ts";

const log = logger("download");

/** 交给任务执行器的控制面：上报进度与查中止 */
export interface TaskControl {
    progress(stage: string, done: number, total: number, bytes: boolean): void;
    isCancelled(): Promise<boolean>;
}

export interface WorkerOptions {
    readonly run: (task: DownloadTask, control: TaskControl) => Promise<void>;
    readonly queuePath?: string;
    readonly lockPath?: string;
    readonly cancelPath?: string;
    /** 进度写盘间隔，测试用 */
    readonly intervalMs?: number;
    readonly clock?: () => number;
}

export interface TaskResult {
    readonly id: string;
    readonly type: string;
    readonly target: string;
    readonly state: "done" | "failed" | "cancelled";
    readonly error: TaskError | null;
}

export interface WorkerReport {
    /** 这次回收的中断任务 id */
    readonly recovered: readonly string[];
    readonly tasks: readonly TaskResult[];
    readonly done: number;
    readonly failed: number;
    readonly cancelled: number;
}

export async function workOffQueue(options: WorkerOptions): Promise<WorkerReport> {
    const queuePath = options.queuePath ?? downloadQueueFile();
    const lockPath = options.lockPath ?? downloadLockFile();
    const cancelPath = options.cancelPath ?? downloadCancelFile();

    const lock = await acquireLock(lockPath);
    try {
        const recovered = await recoverRunning(queuePath);
        for (const id of recovered) {
            log.warn("任务 %s 上次没跑完，已标为 failed", id);
        }

        const results: TaskResult[] = [];
        for (;;) {
            const queue = await readQueue(queuePath);
            const task = queue.tasks.find((one) => one.state === "pending");
            if (task === undefined) {
                break;
            }
            results.push(await runOne(task, queuePath, cancelPath, options));
        }

        return {
            recovered,
            tasks: results,
            done: count(results, "done"),
            failed: count(results, "failed"),
            cancelled: count(results, "cancelled"),
        };
    } finally {
        await lock.release();
    }
}

async function runOne(
    task: DownloadTask,
    queuePath: string,
    cancelPath: string,
    options: WorkerOptions,
): Promise<TaskResult> {
    await patchTask(
        task.id,
        {
            state: "running",
            started: stamp(),
            finished: null,
            error: null,
            progress: null,
            attempts: task.attempts + 1,
        },
        queuePath,
    );

    const allowed = progressThrottle(options.intervalMs, options.clock);
    let latest: TaskProgress | null = null;
    // 进度写盘串行排队，收尾状态一定排在最后一帧之后
    let chain: Promise<unknown> = Promise.resolve();

    const control: TaskControl = {
        progress(stage: string, done: number, total: number, bytes: boolean): void {
            latest = { stage, done, total, bytes, at: stamp() };
            if (!allowed()) {
                return;
            }
            const snapshot = latest;
            chain = chain
                .then(() => patchTask(task.id, { progress: snapshot }, queuePath))
                .catch((error: unknown) => {
                    log.warn("任务 %s 的进度没写进队列：%s", task.id, reasonOf(error));
                });
        },
        isCancelled: async (): Promise<boolean> =>
            (await readCancelRequests(cancelPath)).includes(task.id),
    };

    try {
        if (await control.isCancelled()) {
            throw new TaskCancelled();
        }
        await options.run(task, control);
        await chain;
        await patchTask(
            task.id,
            { state: "done", finished: stamp(), progress: latest, error: null },
            queuePath,
        );
        await clearCancelRequest(task.id, cancelPath);
        return { id: task.id, type: task.type, target: task.target, state: "done", error: null };
    } catch (error) {
        await chain;
        // 执行器报的取消与标记文件都算取消，其余按失败记
        if (
            error instanceof TaskCancelled ||
            (await readCancelRequests(cancelPath)).includes(task.id)
        ) {
            await patchTask(
                task.id,
                { state: "cancelled", finished: stamp(), progress: latest },
                queuePath,
            );
            await clearCancelRequest(task.id, cancelPath);
            return {
                id: task.id,
                type: task.type,
                target: task.target,
                state: "cancelled",
                error: null,
            };
        }

        const failure = taskErrorOf(error);
        await patchTask(
            task.id,
            { state: "failed", finished: stamp(), error: failure, progress: latest },
            queuePath,
        );
        await clearCancelRequest(task.id, cancelPath);
        log.warn("任务 %s 失败：%s", task.id, failure.detail);
        return {
            id: task.id,
            type: task.type,
            target: task.target,
            state: "failed",
            error: failure,
        };
    }
}

function count(results: readonly TaskResult[], state: TaskResult["state"]): number {
    return results.filter((one) => one.state === state).length;
}

function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
