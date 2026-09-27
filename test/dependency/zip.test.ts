/**
 * ZIP 读取：列表、平铺解压、跳过规则、目录穿越
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extractZip, listZip } from "../../src/infra/zip.ts";

// 只用 store 方式拼一个 ZIP，读取端不看 CRC 所以留 0
function zipOf(entries: ReadonlyArray<{ name: string; data: string }>): Buffer {
    const parts: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const data = Buffer.from(entry.data, "utf8");

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);

        parts.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...parts, directory, end]);
}

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-zip-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("列出条目", async () => {
    await inTemp(async (root) => {
        const path = join(root, "a.jar");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, zipOf([{ name: "x/y.txt", data: "hello" }]));

        const entries = await listZip(path);
        assert.equal(entries.length, 1);
        assert.equal(entries[0]?.name, "x/y.txt");
        assert.equal(entries[0]?.size, 5);
        assert.equal(entries[0]?.method, 0);
    });
});

test("平铺解压并按目录跳过", async () => {
    await inTemp(async (root) => {
        const path = join(root, "natives.jar");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(
            path,
            zipOf([
                { name: "META-INF/MANIFEST.MF", data: "meta" },
                { name: "windows/x64/org/lwjgl/glfw/glfw.dll", data: "dll" },
                { name: "windows/x64/org/lwjgl/glfw/glfw.dll.sha1", data: "sha" },
            ]),
        );

        const target = join(root, "out");
        const written = await extractZip(path, target, {
            keep: (name) => !name.startsWith("META-INF/"),
            flatten: true,
        });

        assert.equal(written, 2);
        assert.equal(await readFile(join(target, "glfw.dll"), "utf8"), "dll");
        assert.equal(await readFile(join(target, "glfw.dll.sha1"), "utf8"), "sha");
    });
});

test("保留层级时按原路径落盘", async () => {
    await inTemp(async (root) => {
        const path = join(root, "a.jar");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, zipOf([{ name: "a/b/c.txt", data: "x" }]));

        const target = join(root, "out");
        await extractZip(path, target, {});
        assert.equal(await readFile(join(target, "a", "b", "c.txt"), "utf8"), "x");
    });
});

test("目录穿越的条目被丢掉", async () => {
    await inTemp(async (root) => {
        const path = join(root, "a.jar");
        const { writeFile } = await import("node:fs/promises");
        await writeFile(path, zipOf([{ name: "../逃出去.txt", data: "x" }]));

        const target = join(root, "out");
        const written = await extractZip(path, target, { flatten: false });
        assert.equal(written, 0);
    });
});
