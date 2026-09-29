/**
 * 游戏文件夹：清单核对、自动发现、隔离目录
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { Folder, Instance } from "../../src/config/types.ts";
import {
    folderIdOf,
    pickFolder,
    readFolder,
    sameFolderPath,
    summarizeFolder,
} from "../../src/version/folder.ts";

const VANILLA = { id: "1.20.6", type: "release", mainClass: "net.minecraft.client.main.Main" };

const FABRIC = {
    id: "fabric-loader-0.15.11-1.20.6",
    inheritsFrom: "1.20.6",
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    libraries: [{ name: "net.fabricmc:fabric-loader:0.15.11" }],
};

function instanceOf(id: string, target: string): Instance {
    return { id, target, loader: { type: "vanilla", version: null }, jvmArgs: [], gameArgs: [] };
}

function folderAt(path: string, overrides: Partial<Folder> = {}): Folder {
    return {
        id: overrides.id ?? "test",
        path,
        autoDiscover: overrides.autoDiscover ?? true,
        missingEntries: overrides.missingEntries ?? "keep",
        java: overrides.java ?? null,
        memory: overrides.memory ?? null,
        instances: overrides.instances ?? [],
        ...(overrides.name === undefined ? {} : { name: overrides.name }),
    };
}

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-folder-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

// 造一个带原版与 Fabric 的 versions/
async function seed(root: string): Promise<void> {
    const versions = join(root, "versions");
    await mkdir(join(versions, "1.20.6"), { recursive: true });
    await writeFile(join(versions, "1.20.6", "1.20.6.json"), JSON.stringify(VANILLA));
    await mkdir(join(versions, FABRIC.id), { recursive: true });
    await writeFile(join(versions, FABRIC.id, `${FABRIC.id}.json`), JSON.stringify(FABRIC));
}

test("核对清单与自动发现", async () => {
    await inTemp(async (root) => {
        await seed(root);
        const folder = folderAt(root, {
            instances: [instanceOf("1.20.6", "1.20.6"), instanceOf("已经不在了", "1.20.6")],
        });

        const view = await readFolder(folder);
        assert.equal(view.exists, true);
        assert.equal(view.writable, true);
        assert.deepEqual(
            view.instances.map((instance) => instance.id),
            ["1.20.6", "已经不在了", FABRIC.id],
        );

        const vanilla = view.instances[0];
        assert.equal(vanilla?.state, "ready");
        assert.equal(vanilla?.configured, true);
        assert.equal(vanilla?.discovered, false);
        assert.deepEqual(vanilla?.chain, ["1.20.6"]);
        assert.equal(vanilla?.directory, join(root, "versions", "1.20.6"));

        const missing = view.instances[1];
        assert.equal(missing?.state, "missing");
        assert.equal(missing?.descriptor, null);
        assert.equal(missing?.directory, join(root, "versions", "已经不在了"));

        const fabric = view.instances[2];
        assert.equal(fabric?.state, "ready");
        assert.equal(fabric?.configured, false);
        assert.equal(fabric?.discovered, true);
        assert.equal(fabric?.target, "1.20.6");
        assert.deepEqual(fabric?.loader, { type: "fabric", version: "0.15.11" });
        assert.deepEqual(fabric?.chain, [FABRIC.id, "1.20.6"]);
        assert.deepEqual(view.dropped, []);
    });
});

test("missingEntries=drop 摘掉失效条目", async () => {
    await inTemp(async (root) => {
        await seed(root);
        const folder = folderAt(root, {
            missingEntries: "drop",
            instances: [instanceOf("1.20.6", "1.20.6"), instanceOf("已经不在了", "1.20.6")],
        });

        const view = await readFolder(folder);
        assert.deepEqual(view.dropped, ["已经不在了"]);
        assert.deepEqual(
            view.instances.map((instance) => instance.id),
            ["1.20.6", FABRIC.id],
        );
    });
});

test("关掉自动发现", async () => {
    await inTemp(async (root) => {
        await seed(root);
        const view = await readFolder(folderAt(root, { autoDiscover: false }));
        assert.deepEqual(view.instances, []);
    });
});

test("目录名与 json 的 id 不同时，游戏版本取 id", async () => {
    await inTemp(async (root) => {
        // install --name test6 装出来的样子：目录叫 test6，json 里还是 1.20.6
        await mkdir(join(root, "versions", "test6"), { recursive: true });
        await writeFile(
            join(root, "versions", "test6", "test6.json"),
            JSON.stringify({ id: "1.20.6", type: "release", mainClass: "x.Y" }),
        );

        const view = await readFolder(folderAt(root));
        assert.equal(view.instances[0]?.id, "test6");
        assert.equal(view.instances[0]?.target, "1.20.6");
    });
});

test("目录不存在", async () => {
    await inTemp(async (root) => {
        const view = await readFolder(
            folderAt(join(root, "没有这个目录"), { instances: [instanceOf("1.20.6", "1.20.6")] }),
        );
        assert.equal(view.exists, false);
        assert.equal(view.instances[0]?.state, "missing");
    });
});

test("文件夹摘要只看配置与目录状态", async () => {
    await inTemp(async (root) => {
        const summary = await summarizeFolder(
            folderAt(root, {
                instances: [instanceOf("1.20.6", "1.20.6"), instanceOf("x", "1.20.6")],
            }),
        );
        assert.equal(summary.id, "test");
        assert.equal(summary.path, root);
        assert.equal(summary.exists, true);
        assert.equal(summary.writable, true);
        // 只数配置清单里的条数，不扫磁盘
        assert.equal(summary.instances, 2);

        const missing = await summarizeFolder(folderAt(join(root, "没有这个")));
        assert.equal(missing.exists, false);
        assert.equal(missing.writable, false);
        assert.equal(missing.instances, 0);
    });
});

test("挑文件夹", () => {
    const main = folderAt("/games/main", { id: "main" });
    const second = folderAt("/games/second", { id: "second" });
    const folders = [main, second];

    assert.equal(pickFolder(folders, null, "second")?.id, "second");
    assert.equal(pickFolder(folders, "second")?.id, "second");
    // 选中的不在清单里就退回第一个
    assert.equal(pickFolder(folders, "没有这个")?.id, "main");
    assert.equal(pickFolder([], "main"), undefined);
});

test("标识生成与路径比较", () => {
    assert.equal(folderIdOf("/games/.minecraft", []), "minecraft");
    assert.equal(folderIdOf("/games/.minecraft", ["minecraft"]), "minecraft-2");
    assert.equal(folderIdOf("/games/.minecraft", ["minecraft", "minecraft-2"]), "minecraft-3");
    assert.equal(sameFolderPath("/games/./minecraft", "/games/minecraft/"), true);
    assert.equal(sameFolderPath("/games/.minecraft", "/games/minecraft"), false);
});
