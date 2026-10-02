/**
 * tar 读取：常规文件、目录、前缀字段
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { readTar } from "../../src/infra/tar.ts";

// 手搓一段 tar：256 字节头（八进制大小）+ 数据 + 512 对齐填充
function block(name: string, size: number, type: string, prefix = ""): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write(type, 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    if (prefix !== "") {
        header.write(prefix, 345, 155, "utf8");
    }
    return header;
}

function file(name: string, content: string): Buffer {
    const data = Buffer.from(content, "utf8");
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    return Buffer.concat([block(name, data.length, "0"), padded]);
}

test("读出常规文件的内容与权限", () => {
    const tar = Buffer.concat([
        file("jdk-21/bin/java", "binary"),
        block("jdk-21/", 0, "5"),
        file("jdk-21/release", "JAVA_VERSION=21"),
        Buffer.alloc(1024), // 结束标记
    ]);
    const entries = readTar(tar);

    assert.deepEqual(
        entries.map((entry) => entry.name),
        ["jdk-21/bin/java", "jdk-21", "jdk-21/release"],
    );
    assert.equal(entries[0]?.data.toString("utf8"), "binary");
    assert.equal(entries[0]?.directory, false);
    assert.equal(entries[1]?.directory, true);
    assert.equal(entries[2]?.data.toString("utf8"), "JAVA_VERSION=21");
    assert.equal(entries[0]?.mode, 0o644);
});

test("长名走 prefix 字段，符号链接跳过", () => {
    const long = Buffer.concat([
        block("bin/java", 0, "2", "jdk-21.0.12+8"),
        block("jdk-21/bin/java", 3, "0"),
    ]);
    const entries = readTar(Buffer.concat([long, Buffer.alloc(1024)]));

    assert.deepEqual(
        entries.map((entry) => entry.name),
        ["jdk-21/bin/java"],
    );
});

test("空输入与只有结束标记都给空数组", () => {
    assert.deepEqual(readTar(Buffer.alloc(0)), []);
    assert.deepEqual(readTar(Buffer.alloc(2048)), []);
});
