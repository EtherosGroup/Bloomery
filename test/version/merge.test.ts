/**
 * 版本 json 合并：库与参数的顺序、原版独有字段的保留、继承键的删除
 * @author IsCibocaz
 * @since 1.12.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDescriptor } from "../../src/version/descriptor.ts";
import { mergeManifests, MARK_KEY } from "../../src/version/merge.ts";

// 形状按 1.20.6 的原版 json 裁出来的
function vanilla(): Record<string, unknown> {
    return {
        id: "1.20.6",
        type: "release",
        mainClass: "net.minecraft.client.main.Main",
        assetIndex: { id: "17", sha1: "aaa", size: 1, totalSize: 2, url: "https://x/17.json" },
        assets: "17",
        downloads: {
            client: { sha1: "ccc", size: 100, url: "https://x/client.jar" },
        },
        javaVersion: { component: "java-runtime-delta", majorVersion: 21 },
        libraries: [
            { name: "com.example:shared:1.0", downloads: { artifact: { path: "a.jar" } } },
            { name: "com.example:only-vanilla:2.0" },
        ],
        arguments: {
            game: ["--username", "${auth_player_name}"],
            jvm: ["-Djava.library.path=${natives_directory}"],
        },
    };
}

function fabric(): Record<string, unknown> {
    return {
        id: "fabric-loader-0.19.5-1.20.6",
        inheritsFrom: "1.20.6",
        jar: "1.20.6",
        mainClass: "net.fabricmc.loader.impl.launch.knot.KnotClient",
        libraries: [
            { name: "com.example:shared:1.0", downloads: { artifact: { path: "b.jar" } } },
            { name: "net.fabricmc:fabric-loader:0.19.5" },
        ],
        arguments: {
            game: ["--fabric"],
            jvm: ["-DFabricMcEmu=net.minecraft.client.main.Main"],
        },
    };
}

function merged(): Record<string, unknown> {
    return mergeManifests({
        base: vanilla(),
        loader: fabric(),
        name: "1.20.6-fabric-0.19.5",
        gameVersion: "1.20.6",
        loaderType: "fabric",
        loaderVersion: "0.19.5",
    });
}

function names(value: unknown): string[] {
    return (value as Array<{ name: string }>).map((item) => item.name);
}

test("库：加载器在前，同名只留加载器那份", () => {
    const result = merged();
    assert.deepEqual(names(result["libraries"]), [
        "com.example:shared:1.0",
        "net.fabricmc:fabric-loader:0.19.5",
        "com.example:only-vanilla:2.0",
    ]);
    // 同名条目用的是加载器那份
    const shared = (result["libraries"] as Array<{ downloads: { artifact: { path: string } } }>)[0];
    assert.equal(shared?.downloads.artifact.path, "b.jar");
});

test("参数：原版在前，加载器追加", () => {
    const result = merged();
    const args = result["arguments"] as { game: string[]; jvm: string[] };
    assert.deepEqual(args.game, ["--username", "${auth_player_name}", "--fabric"]);
    assert.deepEqual(args.jvm, [
        "-Djava.library.path=${natives_directory}",
        "-DFabricMcEmu=net.minecraft.client.main.Main",
    ]);
});

test("原版独有的字段保留下来", () => {
    const result = merged();
    assert.deepEqual(result["assetIndex"], vanilla()["assetIndex"]);
    assert.equal(result["assets"], "17");
    assert.deepEqual(result["javaVersion"], { component: "java-runtime-delta", majorVersion: 21 });
    assert.deepEqual(result["downloads"], vanilla()["downloads"]);
    assert.equal(result["type"], "release");
});

test("加载器独有或覆盖的字段生效", () => {
    const result = merged();
    assert.equal(result["mainClass"], "net.fabricmc.loader.impl.launch.knot.KnotClient");
});

test("删除继承关系，id 改成实例名", () => {
    const result = merged();
    assert.equal("inheritsFrom" in result, false);
    assert.equal("jar" in result, false);
    assert.equal(result["id"], "1.20.6-fabric-0.19.5");
});

test("标记键记下游戏版本与加载器", () => {
    const result = merged();
    assert.deepEqual(result[MARK_KEY], {
        layout: "merged",
        gameVersion: "1.20.6",
        loader: { type: "fabric", version: "0.19.5" },
    });
});

test("合并后的 json 读得回来：游戏版本与加载器都认得出", () => {
    const result = merged();
    const descriptor = parseDescriptor(result, "x.json", "1.20.6-fabric-0.19.5", "x.json");
    assert.ok(descriptor !== undefined);
    assert.equal(descriptor.inheritsFrom, null);
    assert.equal(descriptor.layout, "merged");
    assert.equal(descriptor.declaredGameVersion, "1.20.6");
    assert.deepEqual(descriptor.declaredLoader, { type: "fabric", version: "0.19.5" });
});

test("加载器层给 null 时不夺走原版的值", () => {
    const result = mergeManifests({
        base: vanilla(),
        loader: { ...fabric(), mainClass: null, assetIndex: null, javaVersion: undefined },
        name: "x",
        gameVersion: "1.20.6",
        loaderType: "fabric",
        loaderVersion: "0.19.5",
    });
    assert.equal(result["mainClass"], "net.minecraft.client.main.Main");
    assert.deepEqual(result["assetIndex"], vanilla()["assetIndex"]);
    assert.deepEqual(result["javaVersion"], { component: "java-runtime-delta", majorVersion: 21 });
});

test("1.12.2 这类只有 minecraftArguments 的原版", () => {
    const base = {
        id: "1.12.2",
        minecraftArguments: "--username ${auth_player_name}",
        mainClass: "net.minecraft.client.main.Main",
        libraries: [{ name: "com.example:vanilla:1.0" }],
        downloads: { client: { sha1: "s", size: 1, url: "https://x/1.12.2.jar" } },
    };
    const forge = {
        id: "1.12.2-forge-14.23.5.2864",
        inheritsFrom: "1.12.2",
        mainClass: "net.minecraft.launchwrapper.Launch",
        libraries: [{ name: "net.minecraftforge:forge:1.12.2-14.23.5.2864" }],
        minecraftArguments: "--username ${auth_player_name} --tweakClass x",
    };
    const result = mergeManifests({
        base,
        loader: forge,
        name: "1.12.2-forge-14.23.5.2864",
        gameVersion: "1.12.2",
        loaderType: "forge",
        loaderVersion: "14.23.5.2864",
    });
    assert.equal(result["minecraftArguments"], forge.minecraftArguments);
    assert.deepEqual(names(result["libraries"]), [
        "net.minecraftforge:forge:1.12.2-14.23.5.2864",
        "com.example:vanilla:1.0",
    ]);
    assert.deepEqual(result["downloads"], base.downloads);
    assert.equal("arguments" in result, false);
});
