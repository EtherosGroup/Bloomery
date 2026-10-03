/**
 * 后台 worker：入队之后分离拉起
 *
 * 子进程跑 `download run`，stdout 与 stderr 追加到 <日志目录>/worker.log，每次拉起写一行抬头
 * detached 加 unref，父进程退出与终端 Ctrl+C 不影响子进程
 * stdio 走文件 fd，父进程退出后调用方的 stdout 立即 EOF
 * 拉起前查 pid 锁，已有存活 worker 时不重复拉起
 * spawn 实现可注入，测试用替身
 * @author IsCibocaz
 * @since 1.11.0
 */

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { logger } from "../output/index.ts";
import { downloadLockFile, logDirectory } from "../platform/index.ts";
import { lockHolderOf } from "./queue.ts";

const log = logger("download");

/** 后台 worker 的日志文件名，落在日志目录下 */
export const WORKER_LOG_FILE = "worker.log";

/** 跳过后台拉起的环境开关 */
export const NO_WORKER_ENV = "BLOOMERY_NO_WORKER";

/** 后台进程要用的最小形状，测试给替身 */
export interface DetachedChild {
    readonly pid?: number | undefined;
    unref(): void;
}

/** 起进程的实现 */
export type SpawnDetached = (
    execPath: string,
    argv: readonly string[],
    options: SpawnOptions,
) => DetachedChild;

export interface StartWorkerOptions {
    /** pid 锁，默认平台路径 */
    readonly lockPath?: string;
    /** 日志落点，默认 <日志目录>/worker.log */
    readonly logPath?: string;
    /** 透传给子进程的 --home */
    readonly home?: string | undefined;
    /** 进度样式，默认 off（日志文件不留进度帧） */
    readonly progress?: string;
    /** 入队任务 id，只写进日志抬头 */
    readonly task?: string | undefined;
    /** 起进程的实现，测试注入 */
    readonly spawn?: SpawnDetached;
    /** 可执行文件与入口，默认 process.execPath 与 process.argv[1] */
    readonly execPath?: string;
    readonly entry?: string | undefined;
    /** 子进程环境，默认 process.env */
    readonly env?: NodeJS.ProcessEnv;
    /** 抬头的时间戳，测试固定 */
    readonly at?: number;
}

/**
 * 拉起结果：started 已起进程，busy 已有 worker，disabled 设了环境开关，
 * unavailable 入口不可用，failed 进程创建失败
 */
export type WorkerOutcome = "started" | "busy" | "disabled" | "unavailable" | "failed";

export interface WorkerStart {
    readonly outcome: WorkerOutcome;
    /** 本次拉起的 pid，未拉起时为 null */
    readonly pid: number | null;
    /** busy 时给已有 worker 的 pid */
    readonly worker: number | null;
    /** 日志落点 */
    readonly log: string;
    /** failed 与 unavailable 的原因 */
    readonly detail: string | null;
}

export async function startWorker(options: StartWorkerOptions = {}): Promise<WorkerStart> {
    const lockPath = options.lockPath ?? downloadLockFile();
    const logPath = options.logPath ?? join(logDirectory(), WORKER_LOG_FILE);
    const env = options.env ?? process.env;

    if (disabled(env)) {
        return idle("disabled", logPath);
    }

    // 已有 worker 的 pid，新任务由它接走
    const holder = await lockHolderOf(lockPath);
    if (holder !== null) {
        log.debug("已有 worker pid %s，跳过拉起", holder);
        return { outcome: "busy", pid: null, worker: holder, log: logPath, detail: null };
    }

    const execPath = options.execPath ?? process.execPath;
    const entry = options.entry ?? process.argv[1];
    if (entry === undefined || entry === "") {
        log.warn("入口路径不可用，后台 worker 未启动");
        return { ...idle("unavailable", logPath), detail: "入口路径不可用" };
    }

    let fd: number | undefined;
    try {
        await mkdir(dirname(logPath), { recursive: true });
        fd = openSync(logPath, "a");
        writeSync(fd, header(options));

        const child = (options.spawn ?? defaultSpawn)(execPath, [entry, ...argvOf(options)], {
            detached: true,
            stdio: ["ignore", fd, fd],
            windowsHide: true,
            env,
        });
        child.unref();

        if (child.pid === undefined) {
            // 进程创建失败只有 error 事件，此处 pid 为空
            log.warn("后台 worker 子进程创建失败，日志 %s", logPath);
            return { ...idle("failed", logPath), detail: "子进程创建失败" };
        }
        log.info("后台 worker pid %s（任务 %s），日志 %s", child.pid, options.task ?? "-", logPath);
        return { outcome: "started", pid: child.pid, worker: null, log: logPath, detail: null };
    } catch (error) {
        const detail = reasonOf(error);
        log.warn("后台 worker 未启动：%s", detail);
        return { ...idle("failed", logPath), detail };
    } finally {
        // fd 已复制进子进程，父进程侧关闭
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}

// 全局旗标在命令名之前，命令层 strict 解析只吃命令自己的选项
function argvOf(options: StartWorkerOptions): string[] {
    const home = options.home;
    return [
        ...(home === undefined || home === "" ? [] : ["--home", home]),
        "--progress",
        options.progress ?? "off",
        "download",
        "run",
    ];
}

// 每次拉起写一行抬头，追加写按此分轮
function header(options: StartWorkerOptions): string {
    const at = options.at ?? Date.now();
    const task = options.task === undefined || options.task === "" ? "-" : options.task;
    return `# worker ${new Date(at).toISOString()} parent ${process.pid} task ${task}\n`;
}

function idle(outcome: WorkerOutcome, logPath: string): WorkerStart {
    return { outcome, pid: null, worker: null, log: logPath, detail: null };
}

function disabled(env: NodeJS.ProcessEnv): boolean {
    const value = env[NO_WORKER_ENV];
    return value !== undefined && value !== "" && value !== "0";
}

// error 事件无监听时是未捕获异常
function defaultSpawn(
    execPath: string,
    argv: readonly string[],
    options: SpawnOptions,
): DetachedChild {
    const child = nodeSpawn(execPath, [...argv], options);
    child.on("error", () => {});
    return child;
}

function reasonOf(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    const [first = ""] = text.split("\n");
    const line = first.trim();
    return line === "" ? "未知错误" : line;
}
