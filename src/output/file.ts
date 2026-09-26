/**
 * 日志文件落点
 *
 * 一次运行一个文件；不缓冲，每条立即写，崩溃时已写的部分还在
 * 建目录与打开只做一次，清理旧文件失败不致命
 * 只在此处抛错，打印交给 output 层的落点故障机制；落点内不回调输出层
 * @author IsCibocaz
 * @since 1.0.0
 */

import { mkdir, open, readdir, readFile, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { logDirectory } from "../platform/index.ts";
import { addSink, type Sink } from "./output.ts";

const PREFIX = "bloomery-";
const SUFFIX = ".log";
// 保留的日志文件个数，负数表示不限制
const KEEP = -1;
const MAX_BYTES = 32 * 1024 * 1024;

export interface FileSinkOptions {
    /** 落点目录，默认 logDirectory()。测试指到临时目录 */
    readonly directory?: string;
    /** 保留的日志文件个数，默认 10，负数表示不限制 */
    readonly keep?: number;
}

export interface FileSink {
    /** 本次运行的文件路径 */
    readonly path: string;
    /** 是否已经落过盘，没写过就不该把路径提示给用户 */
    readonly opened: boolean;
    /** 等队列排空后调用，之后写入的记录直接丢弃 */
    close(): Promise<void>;
}

export function addFileSink(options: FileSinkOptions = {}): FileSink {
    const directory = options.directory ?? logDirectory();
    const name = fileName(Date.now());
    const path = join(directory, name);
    const keep = options.keep ?? KEEP;
    let handle: FileHandle | undefined;
    let written = 0;
    let closed = false;

    // 失败时不记住句柄，下一条会重试
    async function openOnce(): Promise<FileHandle> {
        if (handle !== undefined) {
            return handle;
        }
        await mkdir(directory, { recursive: true });
        const file = await open(path, "a");
        handle = file;
        await file.write(await sessionHeader(), undefined, "utf8");
        await prune(directory, keep, name).catch(() => {});
        return file;
    }

    const sink: Sink = async (record) => {
        if (closed) {
            return;
        }
        const file = await openOnce();
        const chunk = `${record.line}\n`;
        written += Buffer.byteLength(chunk, "utf8");
        if (written > MAX_BYTES) {
            throw new Error(`日志超过 ${MAX_BYTES} 字节，已停止写入 ${path}`);
        }
        await file.write(chunk, undefined, "utf8");
    };

    const unregister = addSink(sink);

    return {
        path,
        get opened(): boolean {
            return handle !== undefined;
        },
        async close() {
            closed = true;
            unregister();
            await handle?.close();
            handle = undefined;
        },
    };
}

// bloomery-20260926-111659-41392.log，时间戳定长，按名字排序就是按时间排序
// 带 pid 是为了同一秒内起两次不会写进同一个文件
function fileName(at: number): string {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const stamp = [
        d.getFullYear(),
        pad(d.getMonth() + 1),
        pad(d.getDate()),
        "-",
        pad(d.getHours()),
        pad(d.getMinutes()),
        pad(d.getSeconds()),
    ].join("");
    return `${PREFIX}${stamp}-${process.pid}${SUFFIX}`;
}

// 会话头，出问题时这几行省掉一半来回；argv 里不要放密码或 token
async function sessionHeader(): Promise<string> {
    return [
        `# bloomery ${await version()}`,
        `# node ${process.version} ${process.platform} ${process.arch}`,
        `# cwd ${process.cwd()}`,
        `# argv ${process.argv.slice(2).join(" ")}`,
        "",
    ].join("\n");
}

// 读自己的 package.json，读不到就不写版本
async function version(): Promise<string> {
    try {
        const text = await readFile(new URL("../../package.json", import.meta.url), "utf8");
        return (JSON.parse(text) as { version?: string }).version ?? "unknown";
    } catch {
        return "unknown";
    }
}

// 列目录按名字排序，删掉保留数之外的，失败不致命
// 当前这个文件先排除，keep 为 0 或 1 时它也不会被删掉
async function prune(directory: string, keep: number, current: string): Promise<void> {
    if (keep < 0) {
        return;
    }
    const names = (await readdir(directory))
        .filter((entry) => entry.startsWith(PREFIX) && entry.endsWith(SUFFIX) && entry !== current)
        .sort();
    // 旧文件加上当前这个一共留 keep 个，所以旧文件留 keep - 1 个
    for (const entry of names.slice(0, Math.max(0, names.length - (keep - 1)))) {
        await rm(join(directory, entry), { force: true });
    }
}
