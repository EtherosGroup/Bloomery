/**
 * 下载队列：文件即队列
 *
 * 任务清单在 <数据目录>/downloads.json，整份读改写，写入走 writeAtomic
 * 状态机 pending → running → done | failed | cancelled
 * 进度写盘节流，状态变化必写
 * worker 的存活靠 pid 锁判断，中止请求跨进程走单独的标记文件
 * @author IsCibocaz
 * @since 1.11.0
 */

import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { object, parseJson, reader, type Reader } from "../config/read.ts";
import { AppError, errorMessage, errorRetryable, type ErrorCode } from "../error/index.ts";
import { backupFile, readText, writeAtomic } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import { downloadCancelFile, downloadLockFile, downloadQueueFile } from "../platform/index.ts";

const log = logger("download");

/** 当前队列格式版本 */
export const QUEUE_SCHEMA = 1;

/** 进度写盘的最小间隔 */
export const PROGRESS_INTERVAL_MS = 1000;

/** 队列文件里的任务状态 */
export type TaskState = "pending" | "running" | "done" | "failed" | "cancelled";

/** 任务类型，目前只有 MOD 安装 */
export type TaskType = "mod-install";

export interface TaskProgress {
    readonly stage: string;
    readonly done: number;
    readonly total: number;
    readonly bytes: boolean;
    /** RFC3339 UTC */
    readonly at: string;
}

export interface TaskError {
    readonly code: ErrorCode;
    readonly message: string;
    readonly detail: string;
    readonly retryable: boolean;
}

/** mod install 任务的入队参数，路径与版本在入队时定死 */
export interface ModInstallParams {
    readonly query: string;
    readonly modsDirectory: string;
    readonly gameVersion: string | null;
    readonly loader: string | null;
    readonly withDependencies: boolean;
    readonly dryRun: boolean;
}

export interface DownloadTask {
    readonly id: string;
    readonly type: TaskType;
    readonly target: string;
    readonly state: TaskState;
    readonly params: ModInstallParams;
    readonly attempts: number;
    /** RFC3339 UTC */
    readonly created: string;
    readonly started: string | null;
    readonly finished: string | null;
    readonly progress: TaskProgress | null;
    readonly error: TaskError | null;
}

export interface DownloadQueue {
    readonly schemaVersion: number;
    readonly tasks: readonly DownloadTask[];
}

/* ---------- 队列文件 ---------- */

export function emptyQueue(): DownloadQueue {
    return { schemaVersion: QUEUE_SCHEMA, tasks: [] };
}

export async function readQueue(path: string = downloadQueueFile()): Promise<DownloadQueue> {
    const text = await readText(path);
    if (text === undefined) {
        return emptyQueue();
    }

    const parsed = object(parseJson(text, path), path);
    if (parsed === undefined) {
        const kept = await backupFile(path, true);
        log.warn("%s 读不出来，已挪到 %s，队列按空处理", path, kept ?? "(备份失败)");
        return emptyQueue();
    }

    const version = typeof parsed["schemaVersion"] === "number" ? parsed["schemaVersion"] : 0;
    if (version > QUEUE_SCHEMA) {
        throw new AppError("download", "ConfigTooNew", { context: { detail: path } });
    }

    const extras: string[] = [];
    const r = reader("downloads", parsed, extras);
    r.integer("schemaVersion", QUEUE_SCHEMA, 1);
    const tasks = r.list<DownloadTask>("tasks", [], (value, at) => readTask(value, at));
    r.extra();
    if (extras.length > 0) {
        log.warn("%s 里有不认识的键：%s", path, extras.join(", "));
    }
    return { schemaVersion: QUEUE_SCHEMA, tasks };
}

export async function writeQueue(
    queue: DownloadQueue,
    path: string = downloadQueueFile(),
): Promise<void> {
    await writeAtomic(path, `${JSON.stringify(queue, null, 4)}\n`);
}

function readTask(value: unknown, at: string): DownloadTask | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }

    const extras: string[] = [];
    const r = reader(at, raw, extras);
    const id = r.string("id", "");
    const type = r.enumeration("type", ["mod-install"] as const, "mod-install");
    const target = r.string("target", "");
    const params = readModParams(r.object("params"));
    if (id === "" || target === "" || params === undefined) {
        log.warn("%s 缺字段，已忽略这条任务", at);
        r.extra();
        return undefined;
    }

    const task: DownloadTask = {
        id,
        type,
        target,
        state: r.enumeration(
            "state",
            ["pending", "running", "done", "failed", "cancelled"] as const,
            "pending",
        ),
        params,
        attempts: r.integer("attempts", 0, 0),
        created: r.string("created", ""),
        started: r.nullableString("started", null),
        finished: r.nullableString("finished", null),
        progress: readProgress(r.object("progress")),
        error: readError(r.object("error")),
    };
    r.extra();
    return task;
}

function readModParams(sub: Reader | undefined): ModInstallParams | undefined {
    if (sub === undefined) {
        return undefined;
    }
    const params: ModInstallParams = {
        query: sub.string("query", ""),
        modsDirectory: sub.string("modsDirectory", ""),
        gameVersion: sub.string("gameVersion", ""),
        loader: sub.string("loader", ""),
        withDependencies: sub.boolean("withDependencies", true),
        dryRun: sub.boolean("dryRun", false),
    };
    sub.extra();
    if (
        params.query === "" ||
        params.modsDirectory === "" ||
        params.gameVersion === "" ||
        params.loader === ""
    ) {
        return undefined;
    }
    return params;
}

function readProgress(sub: Reader | undefined): TaskProgress | null {
    if (sub === undefined) {
        return null;
    }
    const progress: TaskProgress = {
        stage: sub.string("stage", ""),
        done: sub.integer("done", 0, 0),
        total: sub.integer("total", 0, 0),
        bytes: sub.boolean("bytes", false),
        at: sub.string("at", ""),
    };
    sub.extra();
    return progress.stage === "" ? null : progress;
}

function readError(sub: Reader | undefined): TaskError | null {
    if (sub === undefined) {
        return null;
    }
    const code = sub.string("code", "");
    const error: TaskError = {
        code: code as ErrorCode,
        message: sub.string("message", ""),
        detail: sub.string("detail", ""),
        retryable: sub.boolean("retryable", false),
    };
    sub.extra();
    return code === "" ? null : error;
}

/* ---------- 入队与流转 ---------- */

export interface EnqueueInput {
    readonly type: TaskType;
    readonly target: string;
    readonly params: ModInstallParams;
}

export async function enqueue(
    input: EnqueueInput,
    path: string = downloadQueueFile(),
): Promise<DownloadTask> {
    const queue = await readQueue(path);
    const task: DownloadTask = {
        id: newId(queue.tasks),
        type: input.type,
        target: input.target,
        state: "pending",
        params: input.params,
        attempts: 0,
        created: stamp(),
        started: null,
        finished: null,
        progress: null,
        error: null,
    };
    await writeQueue({ schemaVersion: QUEUE_SCHEMA, tasks: [...queue.tasks, task] }, path);
    return task;
}

export type TaskPatch = Partial<
    Pick<DownloadTask, "state" | "attempts" | "started" | "finished" | "progress" | "error">
>;

export async function patchTask(
    id: string,
    patch: TaskPatch,
    path: string = downloadQueueFile(),
): Promise<DownloadTask | undefined> {
    const queue = await readQueue(path);
    const index = queue.tasks.findIndex((task) => task.id === id);
    if (index < 0) {
        return undefined;
    }
    const next: DownloadTask = { ...(queue.tasks[index] as DownloadTask), ...patch };
    const tasks = [...queue.tasks];
    tasks[index] = next;
    await writeQueue({ schemaVersion: QUEUE_SCHEMA, tasks }, path);
    return next;
}

/** failed 重新排队，其余状态直接报用法 */
export async function retryTask(
    id: string,
    path: string = downloadQueueFile(),
): Promise<DownloadTask> {
    const queue = await readQueue(path);
    const task = queue.tasks.find((one) => one.id === id);
    if (task === undefined) {
        throw new AppError("download", "TaskNotFound", { context: { detail: id } });
    }
    if (task.state !== "failed") {
        throw new AppError("download", "UsageError", {
            context: { detail: `任务状态不是 failed：${task.state}` },
        });
    }
    const next: DownloadTask = {
        ...task,
        state: "pending",
        started: null,
        finished: null,
        progress: null,
        error: null,
    };
    await writeQueue(
        {
            schemaVersion: QUEUE_SCHEMA,
            tasks: queue.tasks.map((one) => (one.id === id ? next : one)),
        },
        path,
    );
    return next;
}

export interface CancelResult {
    readonly task: DownloadTask;
    /** cancelled 是已标记，aborting 是给运行中的 worker 递了中止请求 */
    readonly outcome: "cancelled" | "aborting";
}

export async function cancelTask(
    id: string,
    path: string = downloadQueueFile(),
    cancelPath: string = downloadCancelFile(),
): Promise<CancelResult> {
    const queue = await readQueue(path);
    const task = queue.tasks.find((one) => one.id === id);
    if (task === undefined) {
        throw new AppError("download", "TaskNotFound", { context: { detail: id } });
    }

    if (task.state === "pending") {
        // worker 可能刚好读到这条：标记也让它在起跑前退出
        await requestCancel(id, cancelPath);
        const patched = await patchTask(id, { state: "cancelled", finished: stamp() }, path);
        return { task: patched ?? task, outcome: "cancelled" };
    }
    if (task.state === "running") {
        await requestCancel(id, cancelPath);
        return { task, outcome: "aborting" };
    }
    throw new AppError("download", "UsageError", {
        context: { detail: `任务状态不是 pending 或 running：${task.state}` },
    });
}

/** 清掉终态记录，pending 与 running 不动 */
export async function clearFinished(path: string = downloadQueueFile()): Promise<number> {
    const queue = await readQueue(path);
    const keep = queue.tasks.filter((task) => task.state === "pending" || task.state === "running");
    const removed = queue.tasks.length - keep.length;
    if (removed > 0) {
        await writeQueue({ schemaVersion: QUEUE_SCHEMA, tasks: keep }, path);
    }
    return removed;
}

/* ---------- 崩溃回收 ---------- */

export const CRASH_ERROR: TaskError = {
    code: "DownloadFailed",
    message: errorMessage("DownloadFailed"),
    detail: "worker 中断",
    retryable: true,
};

// 上一次没跑完的 running 任务标 failed：起跑次数与报错都留在记录里，重跑由 download retry 决定
export async function recoverRunning(
    path: string = downloadQueueFile(),
    at: string = stamp(),
): Promise<readonly string[]> {
    const queue = await readQueue(path);
    const running = queue.tasks.filter((task) => task.state === "running");
    if (running.length === 0) {
        return [];
    }
    const tasks = queue.tasks.map((task) =>
        task.state === "running"
            ? { ...task, state: "failed" as const, finished: at, error: CRASH_ERROR }
            : task,
    );
    await writeQueue({ schemaVersion: QUEUE_SCHEMA, tasks }, path);
    return running.map((task) => task.id);
}

/* ---------- 中止标记 ---------- */

export async function requestCancel(
    id: string,
    path: string = downloadCancelFile(),
): Promise<void> {
    const ids = await readCancelRequests(path);
    if (!ids.includes(id)) {
        await writeCancelRequests([...ids, id], path);
    }
}

export async function readCancelRequests(
    path: string = downloadCancelFile(),
): Promise<readonly string[]> {
    const text = await readText(path);
    if (text === undefined) {
        return [];
    }
    const raw = parseJson(text, path);
    if (!Array.isArray(raw)) {
        return [];
    }
    return raw.filter((one): one is string => typeof one === "string" && one !== "");
}

export async function clearCancelRequest(
    id: string,
    path: string = downloadCancelFile(),
): Promise<void> {
    const ids = await readCancelRequests(path);
    if (!ids.includes(id)) {
        return;
    }
    const rest = ids.filter((one) => one !== id);
    if (rest.length === 0) {
        await rm(path, { force: true });
        return;
    }
    await writeCancelRequests(rest, path);
}

async function writeCancelRequests(ids: readonly string[], path: string): Promise<void> {
    await writeAtomic(path, `${JSON.stringify(ids, null, 4)}\n`);
}

/* ---------- pid 锁 ---------- */

export interface QueueLock {
    readonly pid: number;
    release(): Promise<void>;
}

// 锁被活着的进程占着时报 WorkerBusy，残留的锁清掉再抢一次
export async function acquireLock(path: string = downloadLockFile()): Promise<QueueLock> {
    await mkdir(dirname(path), { recursive: true });
    const pid = process.pid;

    if (await createLock(path, pid)) {
        return lockOf(path, pid);
    }

    const held = await lockHolder(path);
    if (held !== null && alive(held)) {
        throw new AppError("download", "WorkerBusy", { context: { detail: `pid ${held}` } });
    }
    log.warn("清掉残留锁 %s（pid %s）", path, held ?? "未知");
    await rm(path, { force: true });

    if (await createLock(path, pid)) {
        return lockOf(path, pid);
    }
    const again = await lockHolder(path);
    throw new AppError("download", "WorkerBusy", {
        context: { detail: `pid ${again ?? "未知"}` },
    });
}

// 排他创建，两个 worker 只有一个能拿到
async function createLock(path: string, pid: number): Promise<boolean> {
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

async function lockHolder(path: string): Promise<number | null> {
    const text = await readText(path);
    if (text === undefined) {
        return null;
    }
    const pid = Number.parseInt(text.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function lockOf(path: string, pid: number): QueueLock {
    return {
        pid,
        // 只删自己写的锁，别的 worker 换了锁之后不误删
        release: async (): Promise<void> => {
            const held = await lockHolder(path);
            if (held === pid) {
                await rm(path, { force: true });
            }
        },
    };
}

// EPERM 说明进程在，只是没权限发信号
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

/** 锁被活着的进程拿着时给它的 pid，残留锁与没锁都给 null */
export async function lockHolderOf(path: string = downloadLockFile()): Promise<number | null> {
    const pid = await lockHolder(path);
    return pid !== null && alive(pid) ? pid : null;
}

/* ---------- 工具 ---------- */

/** RFC3339 UTC */
export function stamp(at: number = Date.now()): string {
    return new Date(at).toISOString();
}

/** 把抛出的东西变成队列记录里的错误 */
export function taskErrorOf(error: unknown): TaskError {
    if (error instanceof AppError) {
        const detail = error.context["detail"];
        return {
            code: error.code,
            message: errorMessage(error.code),
            detail: detail === undefined ? error.code : String(detail),
            retryable: errorRetryable(error.code),
        };
    }
    return {
        code: "UnknownError",
        message: errorMessage("UnknownError"),
        detail: error instanceof Error ? error.message : String(error),
        retryable: false,
    };
}

/** 任务被中止请求打断 */
export class TaskCancelled extends Error {
    constructor() {
        super("TaskCancelled");
        this.name = "TaskCancelled";
    }
}

/** 进度节流：返回 true 表示这一帧该落盘 */
export function progressThrottle(
    interval = PROGRESS_INTERVAL_MS,
    clock: () => number = Date.now,
): (force?: boolean) => boolean {
    let last = Number.NEGATIVE_INFINITY;
    return (force = false): boolean => {
        const now = clock();
        if (!force && now - last < interval) {
            return false;
        }
        last = now;
        return true;
    };
}

// 8 字节随机，队列内不重复即可
function newId(tasks: readonly DownloadTask[]): string {
    for (;;) {
        const id = randomBytes(4).toString("hex");
        if (!tasks.some((task) => task.id === id)) {
            return id;
        }
    }
}
