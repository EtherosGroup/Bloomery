/**
 * versions/ 目录扫描
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanVersions } from "../../src/version/store.ts";

const VANILLA = { id: "1.20.6", type: "release", mainClass: "net.minecraft.client.main.Main" };

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-version-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("目录不存在", async () => {
    await inTemp(async (root) => {
        const scan = await scanVersions(join(root, "没有这个目录"));
        assert.equal(scan.exists, false);
        assert.deepEqual(scan.versions, []);
    });
});

test("扫出各版本，排序稳定", async () => {
    await inTemp(async (root) => {
        const versions = join(root, "versions");
        await mkdir(join(versions, "1.20.6"), { recursive: true });
        await writeFile(join(versions, "1.20.6", "1.20.6.json"), JSON.stringify(VANILLA));
        await writeFile(join(versions, "1.20.6", "1.20.6.jar"), "jar");

        // 第三方安装器改过名的 json
        await mkdir(join(versions, "custom"), { recursive: true });
        await writeFile(
            join(versions, "custom", "renamed.json"),
            JSON.stringify({ id: "custom", inheritsFrom: "1.20.6" }),
        );

        await mkdir(join(versions, "坏掉的"), { recursive: true });
        await writeFile(join(versions, "坏掉的", "坏掉的.json"), "{ 坏掉的");

        await mkdir(join(versions, "空目录"), { recursive: true });

        // 同名文件不是目录，不算版本
        await writeFile(join(versions, "readme.txt"), "x");

        const scan = await scanVersions(root);
        assert.equal(scan.exists, true);
        assert.equal(scan.directory, versions);
        assert.deepEqual(
            scan.versions.map((version) => version.id),
            ["1.20.6", "custom", "坏掉的", "空目录"],
        );

        const vanilla = scan.versions[0];
        assert.equal(vanilla?.jar, true);
        assert.equal(vanilla?.problem, null);
        assert.equal(vanilla?.descriptor?.mainClass, "net.minecraft.client.main.Main");

        const renamed = scan.versions[1];
        assert.equal(renamed?.jar, false);
        assert.equal(renamed?.problem, null);
        assert.equal(renamed?.json.endsWith("renamed.json"), true);
        assert.equal(renamed?.descriptor?.inheritsFrom, "1.20.6");

        const broken = scan.versions[2];
        assert.equal(broken?.descriptor, null);
        assert.notEqual(broken?.problem, null);

        const empty = scan.versions[3];
        assert.equal(empty?.descriptor, null);
        assert.equal(empty?.problem, "目录里没有版本 json");
    });
});
