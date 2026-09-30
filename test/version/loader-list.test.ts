/**
 * 加载器版本清单：四家接口的解析与排序
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchOptions } from "../../src/infra/download.ts";
import { AppError } from "../../src/error/index.ts";
import {
    channelOf,
    filterChannel,
    installerUrlOf,
    listLoaderGames,
    listLoaderVersions,
    listLoaderVersionsFor,
    type LoaderVersion,
    type Transport,
} from "../../src/version/index.ts";

const NETWORK: FetchOptions = {
    timeoutMs: 1000,
    retries: 0,
    proxy: null,
    noProxy: [],
    sources: [{ provider: "official", rewrite: (url: string) => url }],
};

function transport(body: unknown): Transport {
    return async () => Buffer.from(JSON.stringify(body), "utf8");
}

test("通道由版本号判断", () => {
    assert.equal(channelOf("0.19.5"), "release");
    assert.equal(channelOf("0.20.0-beta.1"), "beta");
    assert.equal(channelOf("0.21.0-alpha.3"), "alpha");
    assert.equal(channelOf("1.0.0-rc.2"), "beta");
});

test("filterChannel 只留指定通道，省略则不过滤", () => {
    const list = [
        { version: "0.19.5", gameVersion: null, channel: "release" },
        { version: "0.20.0-beta.1", gameVersion: null, channel: "beta" },
        { version: "0.21.0-alpha.1", gameVersion: null, channel: "alpha" },
    ] as readonly LoaderVersion[];

    assert.equal(filterChannel(list, undefined).length, 3);
    assert.deepEqual(
        filterChannel(list, "release").map((item) => item.version),
        ["0.19.5"],
    );
    assert.deepEqual(
        filterChannel(list, "alpha").map((item) => item.version),
        ["0.21.0-alpha.1"],
    );
    assert.deepEqual(
        filterChannel(list, "beta").map((item) => item.version),
        ["0.20.0-beta.1"],
    );
});

test("fabric 取 version 字段并判通道", async () => {
    const list = await listLoaderVersions(
        "fabric",
        NETWORK,
        transport([
            { version: "0.19.5", stable: true },
            { version: "0.20.0-beta.1" },
            { version: "0.19.4", stable: true },
        ]),
    );

    assert.deepEqual(
        list.map((item) => [item.version, item.channel]),
        [
            ["0.19.5", "release"],
            ["0.20.0-beta.1", "beta"],
            ["0.19.4", "release"],
        ],
    );
    assert.equal(list[0]?.gameVersion, null);
});

test("quilt 用同一套形状", async () => {
    const list = await listLoaderVersions(
        "quilt",
        NETWORK,
        transport([{ version: "0.31.0-beta.4" }, { version: "0.30.0" }]),
    );
    assert.deepEqual(
        list.map((item) => item.version),
        ["0.31.0-beta.4", "0.30.0"],
    );
    assert.equal(list[0]?.channel, "beta");
    assert.equal(list[1]?.channel, "release");
});

test("forge 按游戏版本分组展开并按数值倒排", async () => {
    const list = await listLoaderVersions(
        "forge",
        NETWORK,
        transport({
            "1.9": ["1.9-12.16.1.1938"],
            "1.20.10": ["1.20.10-58.0.0"],
            "1.20.6": ["1.20.6-56.0.0", "1.20.6-56.0.1"],
        }),
    );

    // 字典序会把 1.9 排到 1.20.10 后面，这里必须是数值序
    assert.deepEqual(
        list.slice(0, 3).map((item) => item.version),
        ["1.20.10-58.0.0", "1.20.6-56.0.1", "1.20.6-56.0.0"],
    );
    assert.equal(list[0]?.gameVersion, "1.20.10");
    assert.equal(list[1]?.channel, "release");
});

test("neoforge 取 versions 数组并倒排", async () => {
    const list = await listLoaderVersions(
        "neoforge",
        NETWORK,
        transport({ isSnapshot: false, versions: ["20.2.3-beta", "20.2.5-beta", "20.2.4"] }),
    );
    assert.deepEqual(
        list.map((item) => item.version),
        ["20.2.5-beta", "20.2.4", "20.2.3-beta"],
    );
    assert.equal(list[1]?.channel, "release");
});

test("形状不对时给空清单而不是崩", async () => {
    for (const name of ["fabric", "quilt", "forge", "neoforge"] as const) {
        const list = await listLoaderVersions(name, NETWORK, transport({ unexpected: true }));
        assert.deepEqual(list, [], name);
    }
});

test("按游戏版本查：fabric 取 game 作用域，4xx 当作不支持", async () => {
    const scoped = await listLoaderVersionsFor(
        "fabric",
        "1.20.6",
        NETWORK,
        transport([
            { loader: { version: "0.19.5", stable: true } },
            { loader: { version: "0.20.0-beta.1" } },
        ]),
    );
    assert.deepEqual(
        scoped.map((item) => [item.version, item.channel]),
        [
            ["0.19.5", "release"],
            ["0.20.0-beta.1", "beta"],
        ],
    );

    // 1.7.10 这种 fabric 不支持的游戏版本，接口回 400
    const unsupported = await listLoaderVersionsFor("fabric", "1.7.10", NETWORK, async () => {
        const inner = Object.assign(new Error("HTTP 400"), { status: 400 });
        throw new AppError("download", "DownloadFailed", {
            cause: inner,
            context: { detail: "u" },
        });
    });
    assert.deepEqual(unsupported, []);
});

test("按游戏版本查：forge 取分组键，neoforge 按版本号前两段映射", async () => {
    const forge = await listLoaderVersionsFor(
        "forge",
        "1.20.6",
        NETWORK,
        transport({ "1.20.6": ["1.20.6-56.0.0", "1.20.6-56.0.1"] }),
    );
    assert.deepEqual(
        forge.map((item) => item.version),
        ["1.20.6-56.0.1", "1.20.6-56.0.0"],
    );
    assert.equal(forge[0]?.gameVersion, "1.20.6");

    // 20.6.x 属于 1.20.6，26.2.x 属于 26.2，1.21 的不能被算进来
    const neo = await listLoaderVersionsFor(
        "neoforge",
        "1.20.6",
        NETWORK,
        transport({ isSnapshot: false, versions: ["20.6.141", "21.0.1", "26.2.0.88"] }),
    );
    assert.deepEqual(
        neo.map((item) => item.version),
        ["20.6.141"],
    );
});

test("列出加载器支持的游戏版本", async () => {
    const fabric = await listLoaderGames(
        "fabric",
        NETWORK,
        transport([{ version: "1.20.6" }, { version: "1.21" }]),
    );
    assert.deepEqual(fabric, ["1.20.6", "1.21"]);

    const forge = await listLoaderGames("forge", NETWORK, transport({ "1.9": [], "1.20.10": [] }));
    assert.deepEqual(forge, ["1.20.10", "1.9"]);

    const neo = await listLoaderGames(
        "neoforge",
        NETWORK,
        transport({ versions: ["20.6.1", "26.2.0.88", "21.1.2"] }),
    );
    assert.deepEqual(neo, ["26.2", "1.21.1", "1.20.6"]);
});

test("官方安装器地址：forge 带游戏版本前缀，neoforge 直接用版本号", () => {
    // 这两个地址都用 curl 验过 HTTP 200
    assert.equal(
        installerUrlOf("forge", "1.20.6", "1.20.6-50.2.10"),
        "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.6-50.2.10/forge-1.20.6-50.2.10-installer.jar",
    );
    // 只给后半段时自动补前缀
    assert.equal(
        installerUrlOf("forge", "1.20.6", "50.2.10"),
        "https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.6-50.2.10/forge-1.20.6-50.2.10-installer.jar",
    );
    assert.equal(
        installerUrlOf("neoforge", "1.21.1", "21.1.72"),
        "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.72/neoforge-21.1.72-installer.jar",
    );
    // fabric 与 quilt 走 meta，没有安装器
    assert.equal(installerUrlOf("fabric", "1.20.6", "0.19.5"), null);
    assert.equal(installerUrlOf("quilt", "1.20.6", "0.20.0"), null);
});
