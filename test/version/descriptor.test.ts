/**
 * 版本描述符：解析、继承合并、加载器识别
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    gameVersionOf,
    loaderOf,
    parseDescriptor,
    resolveDescriptor,
    type Descriptor,
} from "../../src/version/descriptor.ts";

const VANILLA = {
    id: "1.20.6",
    type: "release",
    mainClass: "net.minecraft.client.main.Main",
    assets: "17",
    assetIndex: {
        id: "17",
        sha1: "asset-sha1",
        size: 100,
        totalSize: 200,
        url: "https://example.invalid/17.json",
    },
    downloads: {
        client: { sha1: "client-sha1", size: 10, url: "https://example.invalid/client.jar" },
    },
    javaVersion: { component: "java-runtime-delta", majorVersion: 21 },
    libraries: [
        {
            name: "com.mojang:brigadier:1.0.18",
            downloads: {
                artifact: { sha1: "b", size: 1, url: "https://example.invalid/brigadier.jar" },
            },
        },
        { name: "org.lwjgl:lwjgl:3.3.3", natives: { linux: "natives-linux" } },
    ],
    arguments: {
        game: [
            "--username",
            {
                rules: [{ action: "allow", features: { is_demo_user: true } }],
                value: "--demo",
            },
        ],
        jvm: ["-Djava.library.path=${natives_directory}"],
    },
};

const FABRIC = {
    id: "fabric-loader-0.15.11-1.20.6",
    inheritsFrom: "1.20.6",
    mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
    libraries: [
        { name: "net.fabricmc:fabric-loader:0.15.11" },
        { name: "com.mojang:brigadier:1.0.18" },
    ],
    arguments: { jvm: ["-DFabricMcEmu=net.minecraft.client.main.Main"], game: [] },
};

function descriptor(value: unknown, id: string): Descriptor {
    const parsed = parseDescriptor(value, `test:${id}`, id, `/tmp/${id}/${id}.json`);
    assert.ok(parsed !== undefined, `${id} 应该解析得出来`);
    return parsed;
}

test("解析原版描述符", () => {
    const vanilla = descriptor(VANILLA, "1.20.6");

    assert.equal(vanilla.id, "1.20.6");
    assert.equal(vanilla.type, "release");
    assert.equal(vanilla.mainClass, "net.minecraft.client.main.Main");
    assert.equal(vanilla.inheritsFrom, null);
    assert.equal(vanilla.assetIndex?.id, "17");
    assert.equal(vanilla.javaVersion?.majorVersion, 21);
    assert.equal(vanilla.libraries.length, 2);
    assert.equal(vanilla.libraries[1]?.natives["linux"], "natives-linux");
    assert.equal(vanilla.arguments.game.length, 2);
    assert.equal(vanilla.arguments.jvm.length, 1);
    assert.equal(vanilla.downloads["client"]?.size, 10);
});

test("非对象与缺字段", () => {
    assert.equal(parseDescriptor("不是对象", "test", "x", "/tmp/x.json"), undefined);
    assert.equal(parseDescriptor(null, "test", "x", "/tmp/x.json"), undefined);

    const empty = descriptor({}, "空");
    assert.equal(empty.id, "空");
    assert.equal(empty.type, null);
    assert.equal(empty.inheritsFrom, null);
    assert.deepEqual(empty.libraries, []);
    assert.deepEqual(empty.arguments, { game: [], jvm: [] });
});

test("合并 inheritsFrom", () => {
    const byId = new Map<string, Descriptor>([
        ["1.20.6", descriptor(VANILLA, "1.20.6")],
        [FABRIC.id, descriptor(FABRIC, FABRIC.id)],
    ]);

    const resolved = resolveDescriptor(byId, FABRIC.id);
    assert.ok(resolved !== undefined);
    assert.equal(resolved.problem, null);
    assert.deepEqual(resolved.chain, [FABRIC.id, "1.20.6"]);

    const merged = resolved.descriptor;
    assert.equal(merged.mainClass, FABRIC.mainClass);
    assert.equal(merged.inheritsFrom, null);
    // 加载器 profile 不写 type，从父版本取
    assert.equal(merged.type, "release");
    assert.equal(merged.javaVersion?.majorVersion, 21);
    assert.equal(merged.assetIndex?.id, "17");
    // 子在前，父里同名的 brigadier 不再进
    assert.deepEqual(
        merged.libraries.map((library) => library.name),
        [
            "net.fabricmc:fabric-loader:0.15.11",
            "com.mojang:brigadier:1.0.18",
            "org.lwjgl:lwjgl:3.3.3",
        ],
    );
    // 父在前子在后
    assert.equal(merged.arguments.jvm.length, 2);
    assert.equal(merged.arguments.jvm[0], "-Djava.library.path=${natives_directory}");
});

test("识别加载器", () => {
    const vanilla = descriptor(VANILLA, "1.20.6");
    assert.deepEqual(loaderOf(vanilla), { type: "vanilla", version: null });

    const cases: ReadonlyArray<readonly [string, string]> = [
        ["net.fabricmc:fabric-loader:0.15.11", "fabric"],
        ["org.quiltmc:quilt-loader:0.23.1", "quilt"],
        ["net.neoforged:neoforge:21.0.1", "neoforge"],
        ["net.minecraftforge:forge:1.20.6-50.1.0", "forge"],
    ];
    for (const [name, type] of cases) {
        const loader = loaderOf(descriptor({ id: "x", libraries: [{ name }] }, "x"));
        assert.equal(loader.type, type, name);
        assert.equal(loader.version, name.split(":")[2], name);
    }

    // 库名对不上时按 id 兜底
    const byId = loaderOf(descriptor({ id: "1.20.6-forge-50.1.0" }, "1.20.6-forge-50.1.0"));
    assert.equal(byId.type, "forge");
    assert.equal(byId.version, null);
});

test("继承链断裂", () => {
    const byId = new Map<string, Descriptor>([[FABRIC.id, descriptor(FABRIC, FABRIC.id)]]);
    const resolved = resolveDescriptor(byId, FABRIC.id);
    assert.ok(resolved !== undefined);
    assert.deepEqual(resolved.chain, [FABRIC.id]);
    assert.match(resolved.problem ?? "", /找不到继承的版本 1\.20\.6/);
    // 链断也返回已合并的部分
    assert.equal(resolved.descriptor.mainClass, FABRIC.mainClass);
});

test("继承链成环", () => {
    const byId = new Map<string, Descriptor>([
        ["a", descriptor({ id: "a", inheritsFrom: "b" }, "a")],
        ["b", descriptor({ id: "b", inheritsFrom: "a" }, "b")],
    ]);
    const resolved = resolveDescriptor(byId, "a");
    assert.ok(resolved !== undefined);
    assert.match(resolved.problem ?? "", /成环/);
    assert.deepEqual(resolved.chain, ["a", "b"]);
});

test("未知 id 返回 undefined", () => {
    assert.equal(resolveDescriptor(new Map(), "没有这个版本"), undefined);
});

test("判断是哪一版游戏", () => {
    const cases: ReadonlyArray<readonly [unknown, string | null]> = [
        // 原版按 id
        [{ id: "1.20.6" }, "1.20.6"],
        // 继承型最准
        [{ id: "x", inheritsFrom: "1.20.6" }, "1.20.6"],
        // PCL 那类已合并的 profile：加载器库的坐标里带着游戏版本
        [
            {
                id: "1.20.1-Forge_47.4.16",
                libraries: [{ name: "net.minecraftforge:fmlloader:1.20.1-47.4.16" }],
            },
            "1.20.1",
        ],
        [{ id: "x", libraries: [{ name: "net.minecraftforge:forge:1.16.5-36.2.42" }] }, "1.16.5"],
        [
            {
                id: "1.20.6-Fabric 0.17.2",
                libraries: [
                    { name: "net.fabricmc:intermediary:1.20.6" },
                    { name: "net.fabricmc:fabric-loader:0.17.2" },
                ],
            },
            "1.20.6",
        ],
        // 没有 intermediary 时退回 id 里的版本片段
        [
            {
                id: "26.2-Fabric 0.19.3",
                libraries: [{ name: "net.fabricmc:fabric-loader:0.19.3" }],
            },
            "26.2",
        ],
        [{ id: "Create 1.21.1" }, "1.21.1"],
        [{ id: "c0.30_生存测试" }, "c0.30"],
        [{ id: "rd-132211" }, "rd-132211"],
        [{ id: "a1.0.4" }, "a1.0.4"],
        // 认不出就是认不出
        [{ id: "test6" }, null],
    ];

    for (const [json, wanted] of cases) {
        const descriptor = parseDescriptor(json, "t", "t", "/tmp/t/t.json");
        assert.ok(descriptor !== undefined, JSON.stringify(json));
        assert.equal(gameVersionOf(descriptor), wanted, JSON.stringify(json));
    }
});
