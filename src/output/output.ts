/**
 * 输出层：终端与文件两条出口
 *
 *   out()   只输出到终端
 *   log()   只写日志文件，终端看不见
 *   print() 只输出到终端的纯正文，不受级别闸门影响
 *
 * 终端只给正文；文件行带时间、级别与来源。两边互不影响，终端上出现过什么不进文件
 * 终端同步写，顺序等于调用顺序；异步落点走串行队列，退出前用 flush 等它
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
    Info: "INFO ",
    Warning: "WARN ",
    Error: "ERROR",
};

// 终端着色只管会打断用户的级别，正文本身保持原样
const COLOR: Record<Level, number | undefined> = {
    Debug: undefined,
    Info: undefined,
    Warning: 33,
    Error: 31,
};

let threshold: number = SEVERITY.Info;
const colored: boolean = detectColor();

// 调阈值，Silent 之后全部丢弃
export function setLevel(level: LogLevel): void {
    threshold = level === "Silent" ? Number.POSITIVE_INFINITY : SEVERITY[level];
}

// 只输出到终端，不进日志文件
export function out(level: Level, message: string, ...args: unknown[]): void {
    const severity = SEVERITY[level];
    if (severity < threshold) {
        return;
    }

    // Warning 及以上走 stderr
    const target = severity >= SEVERITY.Warning ? STDERR : STDOUT;
    writeLine(target, paint(level, format(message, ...args)));
}

// 只写日志文件，终端看不见
export function log(level: Level, prefix: string, message: string, ...args: unknown[]): void {
    const severity = SEVERITY[level];
    if (severity < threshold || sinks.size === 0) {
        return;
    }

    const at = Date.now();
    const text = format(message, ...args);
    const source = prefix === "" ? "" : `[${prefix}] `;
    const record: LogRecord = {
        level,
        prefix,
        message: text,
        line: `${formatNow(at)} [${LABEL[level]}] ${source}${text}`,
        at,
    };
    queue = queue.then(() => deliver(record)).catch(reportSinkFailure);
}

// 人看的正文，不带时间戳与级别，不受闸门与落点影响
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

// 一个模块一个 logger，前缀固定。模块诊断只落文件，终端要出现的内容用 out()
export function logger(prefix: string): Logger {
    return {
        debug: (message: string, ...args: unknown[]) => log("Debug", prefix, message, ...args),
        info: (message: string, ...args: unknown[]) => log("Info", prefix, message, ...args),
        warn: (message: string, ...args: unknown[]) => log("Warning", prefix, message, ...args),
        error: (message: string, ...args: unknown[]) => log("Error", prefix, message, ...args),
    };
}

function paint(level: Level, text: string): string {
    const code = COLOR[level];
    return colored && code !== undefined ? `\u001B[${code}m${text}\u001B[0m` : text;
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
