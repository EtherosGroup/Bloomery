/**
 * 日志文件落点
 *
 * 当前会话写 latest.log，开写前把上一次的压成 bloomery-<时间戳>.log.gz
 * latest.lock 记着占用者的 pid：抢不到说明别人正在写，本轮改用带 pid 的文件名，不碰 latest.log
 * 只有抢到锁才轮转，因此不会把别人正在写的文件压掉
 * 不缓冲，每条立即写，崩溃时已写的部分还在
 * 建目录与打开只做一次，轮转与清理失败都不致命
 * 只在此处抛错，打印交给 output 层的落点故障机制；落点内不回调输出层
 * @author IsCibocaz
 * @since 1.0.0
 */

import { createReadStream, createWriteStream } from "node:fs";
import {
    mkdir,
    open,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile,
    type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

import { logDirectory } from "../platform/index.ts";
import { addSink, type Sink } from "./output.ts";

const LATEST = "latest.log";
const LOCK = "latest.lock";
// 抢不到锁时的兜底文件名，带 pid 所以不会与别人撞
const RUN = /^bloomery-\d{8}-\d{6}-(\d+)\.log$/;
const ARCHIVE = /^bloomery-\d{8}-\d{6}(-\d+)?\.log\.gz$/;
// 保留的归档个数，负数表示不限制
const KEEP = -1;
const MAX_BYTES = 32 * 1024 * 1024;

export interface FileSinkOptions {
    /** 落点目录，默认 logDirectory()。测试指到临时目录 */
    readonly directory?: string;
    /** 保留的归档个数，负数表示不限制 */
    readonly keep?: number;
}

export interface FileSink {
    /** 本次运行的文件路径 */
    readonly path: string;
    /** 是否已经落过盘，没写过就不该把路径提示给用户 */
    readonly opened: boolean;
    /** 等队列排空后调用，释放锁，之后写入的记录直接丢弃 */
    close(): Promise<void>;
}

export function addFileSink(options: FileSinkOptions = {}): FileSink {
    const directory = options.directory ?? logDirectory();
    const keep = options.keep ?? KEEP;
    let path = join(directory, LATEST);
    let handle: FileHandle | undefined;
    let owned = false;
    let written = 0;
    let closed = false;

    // 失败时不记住句柄，下一条会重试
    async function openOnce(): Promise<FileHandle> {
        if (handle !== undefined) {
            return handle;
        }
        await mkdir(directory, { recursive: true });
        owned = await acquire(directory);
        // 抢到锁才轮转：上一次的占用者已经不在了，latest.log 不会有人再写
        let mode: "w" | "a" = "w";
        if (owned) {
            path = join(directory, LATEST);
            // 归档失败就不截断，接着上一次追加，内容不丢
            mode = (await rotate(directory, LATEST).then(
                () => true,
                () => false,
            ))
                ? "w"
                : "a";
            await sweep(directory).catch(() => {});
        } else {
            path = join(directory, `bloomery-${stampOf(Date.now())}-${process.pid}.log`);
        }

        const file = await open(path, mode);
        handle = file;
        await file.write(await sessionHeader(), undefined, "utf8");
        await prune(directory, keep).catch(() => {});
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
        // 路径在 openOnce 里才定下来，取的时候再读
        get path(): string {
            return path;
        },
        get opened(): boolean {
            return handle !== undefined;
        },
        async close() {
            closed = true;
            unregister();
            await handle?.close();
            handle = undefined;
            if (owned) {
                await rm(join(directory, LOCK), { force: true }).catch(() => {});
            }
        },
    };
}

// 抢锁：写进自己的 pid；锁在但占用者已经不在，就清掉再抢一次
async function acquire(directory: string): Promise<boolean> {
    const lock = join(directory, LOCK);
    for (let round = 0; round < 2; round++) {
        try {
            await writeFile(lock, `${process.pid}\n`, { flag: "wx" });
            return true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }
        }
        const pid = Number.parseInt((await readFile(lock, "utf8").catch(() => "")).trim(), 10);
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
            return false;
        }
        await rm(lock, { force: true });
    }
    return false;
}

// signal 0 只探在不在，不真发信号
function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

// 把上一次的 latest.log 与兜底文件压成归档，先写 .tmp 再改名，不会留下半个归档
async function rotate(directory: string, name: string): Promise<void> {
    const source = join(directory, name);
    const info = await stat(source).catch(() => undefined);
    if (info === undefined || info.size === 0) {
        return;
    }
    const target = join(directory, await freeName(directory, stampOf(info.mtimeMs)));
    const temp = `${target}.tmp`;
    try {
        await pipeline(createReadStream(source), createGzip(), createWriteStream(temp));
        await rename(temp, target);
    } catch (error) {
        await rm(temp, { force: true }).catch(() => {});
        throw error;
    }
    await rm(source, { force: true }).catch(() => {});
}

// 兜底文件与旧命名留下的文件也压成归档，只碰 pid 已经不在的那些
async function sweep(directory: string): Promise<void> {
    for (const entry of await readdir(directory)) {
        const matched = RUN.exec(entry);
        if (matched === null) {
            continue;
        }
        const pid = Number.parseInt(matched[1] ?? "", 10);
        if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
            continue;
        }
        await rotate(directory, entry).catch(() => {});
    }
}

// 同一秒装完两次会撞名，撞了往后加序号
async function freeName(directory: string, stamp: string): Promise<string> {
    for (let i = 0; i < 100; i++) {
        const name = i === 0 ? `bloomery-${stamp}.log.gz` : `bloomery-${stamp}-${i}.log.gz`;
        if (!(await exists(join(directory, name)))) {
            return name;
        }
    }
    throw new Error(`归档名用尽：${stamp}`);
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

// 时间戳定长，按名字排序就是按时间排序
function stampOf(at: number): string {
    const d = new Date(at);
    const pad = (n: number): string => String(n).padStart(2, "0");
    return [
        d.getFullYear(),
        pad(d.getMonth() + 1),
        pad(d.getDate()),
        "-",
        pad(d.getHours()),
        pad(d.getMinutes()),
        pad(d.getSeconds()),
    ].join("");
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

// 只数归档，latest.log 与兜底文件都不参与，负数表示不限制
async function prune(directory: string, keep: number): Promise<void> {
    if (keep < 0) {
        return;
    }
    const names = (await readdir(directory)).filter((entry) => ARCHIVE.test(entry)).sort();
    for (const entry of names.slice(0, Math.max(0, names.length - keep))) {
        await rm(join(directory, entry), { force: true });
    }
}
