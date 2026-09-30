/**
 * 整合包：清单解析与待下文件
 * @author IsCibocaz
 * @since 1.3.0
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { AppError } from "../../src/error/index.ts";
import { modpackTasks, parseMrpack } from "../../src/modpack/index.ts";

const MANIFEST = {
    formatVersion: 1,
    game: "minecraft",
    versionId: "abc",
    name: "测试包",
    dependencies: { minecraft: "1.20.6", "fabric-loader": "0.15.11" },
    files: [
        {
            path: "mods/sodium.jar",
            hashes: { sha1: "aaa", sha512: "bbb" },
            fileSize: 1000,
            downloads: ["https://cdn.modrinth.com/data/x/versions/y/sodium.jar"],
            env: { client: "required", server: "unsupported" },
        },
        {
            path: "mods/server-only.jar",
            hashes: { sha1: "ccc" },
            downloads: ["https://example.com/server.jar"],
            env: { client: "unsupported", server: "required" },
        },
        {
            path: "mods/no-url.jar",
            hashes: { sha1: "ddd" },
            downloads: [],
        },
    ],
};

test("解析清单：游戏版本、加载器与文件", () => {
    const pack = parseMrpack(MANIFEST, "test");
    assert.equal(pack.name, "测试包");
    assert.equal(pack.versionId, "1.20.6");
    assert.deepEqual(pack.loader, { name: "fabric", version: "0.15.11" });
    assert.equal(pack.files.length, 3);
    assert.equal(pack.files[0]?.sha1, "aaa");
    assert.equal(pack.files[0]?.size, 1000);
    assert.equal(pack.files[1]?.client, false);
    assert.equal(pack.files[2]?.url, null);
});

test("别的加载器与无加载器都认", () => {
    const forge = parseMrpack(
        { dependencies: { minecraft: "1.20.1", forge: "47.2.0" }, files: [] },
        "test",
    );
    assert.deepEqual(forge.loader, { name: "forge", version: "47.2.0" });

    const vanilla = parseMrpack({ dependencies: { minecraft: "1.20.6" }, files: [] }, "test");
    assert.equal(vanilla.loader, null);
    assert.equal(vanilla.name, null);
});

test("缺 minecraft 依赖或路径不合法时拒绝", () => {
    assert.throws(
        () => parseMrpack({ dependencies: { "fabric-loader": "0.15.11" }, files: [] }, "test"),
        (error: unknown) => {
            assert.ok(error instanceof AppError);
            assert.equal(error.code, "VersionBroken");
            return true;
        },
    );

    // 绝对路径与上跳路径都不进任务表
    const pack = parseMrpack(
        {
            dependencies: { minecraft: "1.20.6" },
            files: [
                { path: "/etc/passwd", downloads: ["https://e/x.jar"] },
                { path: "../escape.jar", downloads: ["https://e/y.jar"] },
                { path: "mods/ok.jar", downloads: ["https://e/z.jar"] },
            ],
        },
        "test",
    );
    assert.equal(pack.files.length, 1);
});

test("待下任务：跳过服务端专属与没有地址的，落点在实例目录下", () => {
    const pack = parseMrpack(MANIFEST, "test");
    const { tasks, warnings } = modpackTasks(pack, "/games/versions/pack");

    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.target, join("/games/versions/pack", "mods/sodium.jar"));
    assert.equal(tasks[0]?.sha1, "aaa");
    assert.match(warnings.join(" "), /no-url\.jar/);
});
