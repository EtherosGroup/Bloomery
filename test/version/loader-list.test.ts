/**
 * 加载器版本清单：四家接口的解析与排序
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { FetchOptions } from "../../src/infra/download.ts";
import { listLoaderVersions, type Transport } from "../../src/version/index.ts";

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

test("fabric 取 version 字段，stable 缺失时按版本号猜", async () => {
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
        list.map((item) => [item.version, item.stable]),
        [
            ["0.19.5", true],
            ["0.20.0-beta.1", false],
            ["0.19.4", true],
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
    assert.equal(list[0]?.stable, false);
    assert.equal(list[1]?.stable, true);
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
    assert.equal(list[1]?.stable, true);
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
    assert.equal(list[1]?.stable, true);
});

test("形状不对时给空清单而不是崩", async () => {
    for (const name of ["fabric", "quilt", "forge", "neoforge"] as const) {
        const list = await listLoaderVersions(name, NETWORK, transport({ unexpected: true }));
        assert.deepEqual(list, [], name);
    }
});
