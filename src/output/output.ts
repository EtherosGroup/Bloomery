/**
 * 输出层：分级日志
 *
 * 数据走 stdout，诊断走 stderr，管道里能直接拿到干净结果
 * 控制台同步写，顺序等于调用顺序；异步落点走串行队列，退出前用 flush 等它
 * 级别与颜色是进程级状态，由 main.ts 依 argv 设定
 * @author IsCibocaz
 * @since 1.0.0
 */

import { writeSync } from "node:fs";
import { format } from "node:util";

export type Level = "Debug" | "Info" | "Warning" | "Error";

export type LogLevel = Level | "Silent";

export interface LogRecord {
    readonly level: Level;
    readonly prefix: string;
    /** 已格式化的正文，占位符展开后的结果 */
    readonly message: string;
    /** 整行，无颜色，落点可以直接写盘 */
    readonly line: string;
    /** epoch 毫秒 */
    readonly at: number;
}

/** 异步落点，返回的 Promise 在数据落地后才 resolve */
export type Sink = (record: LogRecord) => void | Promise<void>;

const STDOUT = 1;
const STDERR = 2;

// 级别闸门
const SEVERITY: Record<Level, number> = {
    Debug: 0,
    Info: 1,
    Warning: 2,
    Error: 3,
};

const LABEL: Record<Level, string> = {
    Debug: "DEBUG",
    Info: "INFO",
    Warning: "WARN",
    Error: "ERROR",
};

// ANSI 前景色：亮黑、青、黄、红
const COLOR: Record<Level, number> = {
    Debug: 90,
    Info: 36,
    Warning: 33,
    Error: 31,
};

let threshold: number = SEVERITY.Info;
const colored: boolean = detectColor();

// 调阈值，Silent 之后全部丢弃
export function setLevel(level: LogLevel): void {
    threshold = level === "Silent" ? Number.POSITIVE_INFINITY : SEVERITY[level];
}

export function out(level: Level, prefix: string, message: string, ...args: unknown[]): void {
    const severity = SEVERITY[level];
    if (severity < threshold) {
        return;
    }

    const at = Date.now();
    const text = format(message, ...args);
    const plain = composeLine(at, level, prefix, text, false);
    // Warning 及以上走 stderr
    const target = severity >= SEVERITY.Warning ? STDERR : STDOUT;
    writeLine(target, colored ? composeLine(at, level, prefix, text, true) : plain);

    if (sinks.size > 0) {
        const record: LogRecord = { level, prefix, message: text, line: plain, at };
        queue = queue.then(() => deliver(record)).catch(reportSinkFailure);
    }
}

// 人看的正文，不带时间戳与级别，不进落点
export function print(text: string): void {
    writeLine(STDOUT, text);
}

// 人看的错误，同上，走 stderr
export function printError(text: string): void {
    writeLine(STDERR, text);
}

const sinks = new Set<Sink>();
// 落点队列，保证落点看到的顺序等于调用顺序
let queue: Promise<void> = Promise.resolve();
// 落点故障只报一次，恢复后重新计数
let sinkFailed = false;

// 注册落点，返回注销函数
export function addSink(sink: Sink): () => void {
    sinks.add(sink);
    return () => {
        sinks.delete(sink);
    };
}

// 等已排队的落点写入完成，flush 之后新增的记录不在等待范围内
export function flush(): Promise<void> {
    return queue;
}

// 依次喂给所有落点，单个落点异常不影响其余落点
async function deliver(record: LogRecord): Promise<void> {
    let ok = true;
    for (const sink of sinks) {
        try {
            await sink(record);
        } catch (error) {
            ok = false;
            reportSinkFailure(error);
        }
    }
    if (ok) {
        sinkFailed = false;
    }
}

// 落点故障不受级别闸门影响，直接写 stderr，不再入队
function reportSinkFailure(error: unknown): void {
    if (sinkFailed) {
        return;
    }
    sinkFailed = true;
    writeLine(
        STDERR,
        `${formatNow(Date.now())} [${LABEL.Error}][output] 落点写入失败 ${format(error)}`,
    );
}

// 写不进去的 fd，后续写入丢弃
const dead = new Set<number>();

// 同步写，绕开两条流各自的缓冲
function writeLine(fd: number, text: string): void {
    if (dead.has(fd)) {
        return;
    }

    const buffer = Buffer.from(`${text}\n`, "utf8");
    let offset = 0;
    while (offset < buffer.length) {
        try {
            offset += writeSync(fd, buffer, offset, buffer.length - offset);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            // 接收端已关闭，例如下游的 head 提前退出
            if (code === "EPIPE" || code === "EBADF") {
                dead.add(fd);
                return;
            }
            // 非阻塞 fd 写满
            if (code === "EAGAIN") {
                sleep(1);
                continue;
            }
            throw error;
        }
    }
}

// 同步等待，只用于 EAGAIN 重试
function sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export interface Logger {
    debug(message: string, ...args: unknown[]): void;
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
}

// 一个模块一个 logger，前缀固定
export function logger(prefix: string): Logger {
    return {
        debug: (message: string, ...args: unknown[]) => out("Debug", prefix, message, ...args),
        info: (message: string, ...args: unknown[]) => out("Info", prefix, message, ...args),
        warn: (message: string, ...args: unknown[]) => out("Warning", prefix, message, ...args),
        error: (message: string, ...args: unknown[]) => out("Error", prefix, message, ...args),
    };
}

function composeLine(
    at: number,
    level: Level,
    prefix: string,
    text: string,
    color: boolean,
): string {
    return `${formatNow(at)} [${renderLabel(level, color)}][${prefix}] ${text}`;
}

function renderLabel(level: Level, color: boolean): string {
    const label = LABEL[level].padEnd(5);
    return color ? `\u001B[${COLOR[level]}m${label}\u001B[0m` : label;
}

function formatNow(at: number): string {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function detectColor(): boolean {
    // FORCE_COLOR 是显式要求，优先于其余抑制信号
    const force = process.env.FORCE_COLOR;
    if (force !== undefined && force !== "" && force !== "0") {
        return true;
    }
    if (force === "0") {
        return false;
    }
    if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
        return false;
    }
    if (process.env.TERM === "dumb") {
        return false;
    }
    return process.stdout.isTTY === true;
}
