/**
 * 官方安装器产物改名接管：目录、json 文件名、json 里的 id 与 jar
 * @author IsCibocaz
 * @since 1.6.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { adoptVersion } from "../../src/version/index.ts";

async function forgeLike(withJarField: boolean): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-adopt-"));
    const dir = join(root, "versions", "1.20.6-forge-50.2.10");
    await mkdir(dir, { recursive: true });
    const json: Record<string, unknown> = {
        id: "1.20.6-forge-50.2.10",
        inheritsFrom: "1.20.6",
        mainClass: "net.minecraftforge.bootstrap.ForgeBootstrap",
    };
    if (withJarField) {
        json["jar"] = "1.20.6-forge-50.2.10";
    }
    await writeFile(join(dir, "1.20.6-forge-50.2.10.json"), JSON.stringify(json));
    await writeFile(join(dir, "1.20.6-forge-50.2.10.jar"), "jar");
    return root;
}

test("改名后只剩一层继承，目录与 json 名跟着实例名", async () => {
    const root = await forgeLike(false);
    await adoptVersion(root, "1.20.6-forge-50.2.10", "test1");

    const target = join(root, "versions", "test1");
    assert.deepEqual((await readdir(target)).sort(), ["test1.jar", "test1.json"]);

    const json = JSON.parse(await readFile(join(target, "test1.json"), "utf8"));
    assert.equal(json.id, "test1");
    // 继承的还是游戏版本，不指向自己
    assert.equal(json.inheritsFrom, "1.20.6");
    assert.equal(json.mainClass, "net.minecraftforge.bootstrap.ForgeBootstrap");

    // 旧目录不残留
    assert.deepEqual(await readdir(join(root, "versions")), ["test1"]);
});

test("json 里指向自己的 jar 字段跟着改", async () => {
    const root = await forgeLike(true);
    await adoptVersion(root, "1.20.6-forge-50.2.10", "test1");
    const json = JSON.parse(await readFile(join(root, "versions", "test1", "test1.json"), "utf8"));
    assert.equal(json["jar"], "test1");
});

test("没有 json 时只改目录，不报错", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-adopt-"));
    await mkdir(join(root, "versions", "x"), { recursive: true });
    await adoptVersion(root, "x", "y");
    assert.deepEqual(await readdir(join(root, "versions")), ["y"]);
});
