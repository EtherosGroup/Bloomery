/**
 * ZIP 读取：列表、平铺解压、跳过规则、目录穿越
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extractZip, listZip } from "../../src/infra/zip.ts";
import { zipOf } from "../helpers/server.ts";

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
        await writeFile(path, zipOf([{ name: "a/b/c.txt", data: "x" }]));

        const target = join(root, "out");
        await extractZip(path, target, {});
        assert.equal(await readFile(join(target, "a", "b", "c.txt"), "utf8"), "x");
    });
});

test("目录穿越的条目被丢掉", async () => {
    await inTemp(async (root) => {
        const path = join(root, "a.jar");
        await writeFile(path, zipOf([{ name: "../逃出去.txt", data: "x" }]));

        const target = join(root, "out");
        const written = await extractZip(path, target, { flatten: false });
        assert.equal(written, 0);
    });
});
