/**
 * 加载器版本清单：四家接口的解析与排序
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchOptions } from "../../src/infra/download.ts";
import {
    channelOf,
    filterChannel,
    listLoaderVersions,
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
