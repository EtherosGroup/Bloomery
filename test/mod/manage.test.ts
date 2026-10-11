/**
 * 已装 MOD 的删除、禁用与启用
 * @author IsCibocaz
 * @since 1.13.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { manageMods } from "../../src/mod/index.ts";

async function withMods(
    names: readonly string[],
    body: (directory: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-mod-manage-"));
    const mods = join(root, "mods");
    await mkdir(mods, { recursive: true });
    for (const name of names) {
        await writeFile(join(mods, name), `jar:${name}`);
    }
    try {
        await body(mods);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("禁用改名加 .disabled，启用改回来", async () => {
    await withMods(["sodium.jar"], async (mods) => {
        const off = await manageMods({
            modsDirectory: mods,
            action: "disable",
            targets: ["sodium.jar"],
        });
        assert.deepEqual(off.changed, [
            { from: "sodium.jar", to: "sodium.jar.disabled", path: join(mods, "sodium.jar") },
        ]);
        assert.deepEqual(await readdir(mods), ["sodium.jar.disabled"]);

        const on = await manageMods({
            modsDirectory: mods,
            action: "enable",
            targets: ["sodium.jar.disabled"],
        });
        assert.equal(on.changed[0]?.to, "sodium.jar");
        assert.deepEqual(await readdir(mods), ["sodium.jar"]);
    });
});

test("按去掉后缀的名字也能命中", async () => {
    await withMods(["sodium-fabric-0.5.3.jar"], async (mods) => {
        const report = await manageMods({
            modsDirectory: mods,
            action: "disable",
            targets: ["sodium-fabric-0.5.3"],
        });
        assert.equal(report.changed[0]?.to, "sodium-fabric-0.5.3.jar.disabled");
    });
});

test("删除落盘，重复删与没命中都进 skipped", async () => {
    await withMods(["a.jar", "b.jar"], async (mods) => {
        const report = await manageMods({
            modsDirectory: mods,
            action: "remove",
            targets: ["a.jar", "a.jar", "nope.jar"],
        });
        assert.deepEqual(
            report.changed.map((one) => one.from),
            ["a.jar"],
        );
        assert.deepEqual(report.changed[0]?.to, null);
        assert.deepEqual(report.skipped, [{ target: "nope.jar", reason: "not-found" }]);
        assert.deepEqual(await readdir(mods), ["b.jar"]);
    });
});

test("状态已经对不当作错误", async () => {
    await withMods(["a.jar", "b.jar.disabled"], async (mods) => {
        const disable = await manageMods({
            modsDirectory: mods,
            action: "disable",
            targets: ["b.jar.disabled"],
        });
        assert.deepEqual(disable.skipped, [
            { target: "b.jar.disabled", reason: "already-disabled" },
        ]);
        assert.deepEqual(disable.changed, []);

        const enable = await manageMods({
            modsDirectory: mods,
            action: "enable",
            targets: ["a.jar"],
        });
        assert.deepEqual(enable.skipped, [{ target: "a.jar", reason: "already-enabled" }]);
    });
});

test("同名候选多个算重名，不动磁盘", async () => {
    await withMods(["x.jar", "x.jar.disabled"], async (mods) => {
        const report = await manageMods({ modsDirectory: mods, action: "remove", targets: ["x"] });
        assert.deepEqual(report.changed, []);
        assert.deepEqual(report.skipped, [{ target: "x", reason: "ambiguous" }]);
        assert.equal((await readdir(mods)).length, 2);
    });
});

test("目标文件名被占用时报冲突", async () => {
    await withMods(["x.jar", "x.jar.disabled"], async (mods) => {
        // 精确命中启用态那个，但 .disabled 已经存在
        const report = await manageMods({
            modsDirectory: mods,
            action: "disable",
            targets: ["x.jar"],
        });
        assert.deepEqual(report.changed, []);
        assert.deepEqual(report.skipped, [{ target: "x.jar", reason: "conflict" }]);
    });
});

test("dry-run 只报不改", async () => {
    await withMods(["a.jar"], async (mods) => {
        const report = await manageMods({
            modsDirectory: mods,
            action: "disable",
            targets: ["a.jar"],
            dryRun: true,
        });
        assert.equal(report.dryRun, true);
        assert.equal(report.changed.length, 1);
        assert.deepEqual(await readdir(mods), ["a.jar"]);
    });
});
