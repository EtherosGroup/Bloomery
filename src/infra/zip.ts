/**
 * 最小 ZIP 读取
 *
 * 只为解压 natives：不支持 ZIP64 与加密
 * 从文件尾部找中央目录，逐条读本地头算出数据偏移；method 8 走 inflateRaw，method 0 直接拷
 * @author IsCibocaz
 * @since 1.0.0
 */

import { mkdir, open, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { inflateRaw } from "node:zlib";

const inflate = promisify(inflateRaw);

const SIGNATURE_END = 0x06054b50;
const SIGNATURE_CENTRAL = 0x02014b50;
const SIGNATURE_LOCAL = 0x04034b50;
const LOCAL_HEADER_BYTES = 30;
const END_BYTES = 22;
// 中央目录后面最多再挂 65535 字节注释
const MAX_COMMENT = 0xffff;

export interface ZipEntry {
    readonly name: string;
    readonly method: number;
    readonly compressedSize: number;
    readonly size: number;
    /** 本地头在文件里的偏移 */
    readonly offset: number;
}

export async function listZip(path: string): Promise<readonly ZipEntry[]> {
    const file = await open(path, "r");
    try {
        return await readDirectory(file, path);
    } finally {
        await file.close();
    }
}

// keep 返回 false 的条目跳过
// flatten 只留文件名：natives 的 dll/so 要平铺，java.library.path 不递归查找
export async function extractZip(
    path: string,
    destination: string,
    options: ExtractOptions = {},
): Promise<number> {
    const file = await open(path, "r");
    try {
        const entries = await readDirectory(file, path);
        let written = 0;
        for (const entry of entries) {
            if (entry.name.endsWith("/")) {
                continue;
            }
            if (options.keep !== undefined && !options.keep(entry.name)) {
                continue;
            }
            const named = options.flatten === true ? basename(entry.name) : entry.name;
            const name = options.strip === undefined ? named : options.strip(named);
            if (name === "") {
                continue;
            }
            const target = safeJoin(destination, name);
            if (target === undefined) {
                continue;
            }
            const data = await readEntry(file, entry);
            if (data === undefined) {
                continue;
            }
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, data);
            written++;
        }
        return written;
    } finally {
        await file.close();
    }
}

export interface ExtractOptions {
    readonly keep?: (name: string) => boolean;
    readonly flatten?: boolean;
    /** 剥掉条目前缀，用来把 overrides/ 里的文件摊到目标目录 */
    readonly strip?: (name: string) => string;
}

// 读单个条目，找不到返回 undefined
export async function readZipEntry(path: string, name: string): Promise<Buffer | undefined> {
    const file = await open(path, "r");
    try {
        const entry = (await readDirectory(file, path)).find((item) => item.name === name);
        // 必须 await：不等它读完 finally 就把文件关了
        return entry === undefined ? undefined : await readEntry(file, entry);
    } finally {
        await file.close();
    }
}

async function readDirectory(file: FileHandle, path: string): Promise<ZipEntry[]> {
    const size = (await file.stat()).size;
    const tail = Math.min(size, MAX_COMMENT + END_BYTES);
    const buffer = Buffer.alloc(tail);
    await file.read(buffer, 0, tail, size - tail);

    let end = -1;
    for (let at = tail - END_BYTES; at >= 0; at--) {
        if (buffer.readUInt32LE(at) === SIGNATURE_END) {
            end = at;
            break;
        }
    }
    if (end < 0) {
        throw new Error(`${path} 不是 ZIP：找不到中央目录`);
    }

    const count = buffer.readUInt16LE(end + 10);
    const directorySize = buffer.readUInt32LE(end + 12);
    const directoryOffset = buffer.readUInt32LE(end + 16);
    const directory = Buffer.alloc(directorySize);
    await file.read(directory, 0, directorySize, directoryOffset);

    const entries: ZipEntry[] = [];
    let at = 0;
    for (let index = 0; index < count; index++) {
        if (at + 46 > directory.length || directory.readUInt32LE(at) !== SIGNATURE_CENTRAL) {
            break;
        }
        const nameLength = directory.readUInt16LE(at + 28);
        const extraLength = directory.readUInt16LE(at + 30);
        const commentLength = directory.readUInt16LE(at + 32);
        entries.push({
            name: directory.toString("utf8", at + 46, at + 46 + nameLength),
            method: directory.readUInt16LE(at + 10),
            compressedSize: directory.readUInt32LE(at + 20),
            size: directory.readUInt32LE(at + 24),
            offset: directory.readUInt32LE(at + 42),
        });
        at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

async function readEntry(file: FileHandle, entry: ZipEntry): Promise<Buffer | undefined> {
    const header = Buffer.alloc(LOCAL_HEADER_BYTES);
    await file.read(header, 0, LOCAL_HEADER_BYTES, entry.offset);
    if (header.readUInt32LE(0) !== SIGNATURE_LOCAL) {
        return undefined;
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const start = entry.offset + LOCAL_HEADER_BYTES + nameLength + extraLength;
    if (entry.compressedSize === 0) {
        return Buffer.alloc(0);
    }

    const raw = Buffer.alloc(entry.compressedSize);
    await file.read(raw, 0, entry.compressedSize, start);
    if (entry.method === 0) {
        return raw;
    }
    if (entry.method === 8) {
        return inflate(raw);
    }
    throw new Error(`不支持的压缩方式 ${entry.method}：${entry.name}`);
}

// 条目名不许逃出目标目录
function safeJoin(root: string, name: string): string | undefined {
    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0 || parts.some((part) => part === "..")) {
        return undefined;
    }
    return join(root, ...parts);
}
