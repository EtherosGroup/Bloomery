/**
 * 最小 tar 读取
 *
 * 只认 ustar 的常规文件与目录，长名、稀疏文件、硬链接都不处理
 * 配合 node:zlib 的 gunzip 就能读 .tar.gz；Java 运行时的包正好是这个形态
 * @author IsCibocaz
 * @since 1.9.0
 */

const BLOCK = 512;

export interface TarEntry {
    /** 相对包根的路径 */
    readonly name: string;
    readonly data: Buffer;
    readonly mode: number;
    readonly directory: boolean;
}

export function readTar(buffer: Buffer): TarEntry[] {
    const entries: TarEntry[] = [];
    let at = 0;

    while (at + BLOCK <= buffer.length) {
        const header = buffer.subarray(at, at + BLOCK);
        // 全零块是结束标记，后面可能还有填充
        if (header.every((byte) => byte === 0)) {
            break;
        }

        const size = octal(header, 124, 12);
        const mode = octal(header, 100, 8) || 0o644;
        const type = String.fromCharCode(header[156] ?? 0);
        const prefix = text(header, 345, 155);
        const name = text(header, 0, 100);
        const full = prefix === "" ? name : `${prefix}/${name}`;
        const data = buffer.subarray(at + BLOCK, at + BLOCK + size);

        if (type === "5") {
            entries.push({
                name: full.replace(/\/+$/, ""),
                data: Buffer.alloc(0),
                mode,
                directory: true,
            });
        } else if (type === "0" || type === "\0" || type === "") {
            entries.push({ name: full, data, mode, directory: false });
        }
        // 其余类型（符号链接、硬链接等）跳过

        at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
    return entries;
}

// tar 里的字符串字段是 NUL 结尾的定长区
function text(buffer: Buffer, start: number, length: number): string {
    const slice = buffer.subarray(start, start + length);
    const end = slice.indexOf(0);
    return slice.toString("utf8", 0, end < 0 ? slice.length : end);
}

// 数字字段是八进制，可能带空格与 NUL
function octal(buffer: Buffer, start: number, length: number): number {
    const raw = text(buffer, start, length).trim().replace(/\0/g, "");
    const value = Number.parseInt(raw, 8);
    return Number.isFinite(value) && value > 0 ? value : 0;
}
