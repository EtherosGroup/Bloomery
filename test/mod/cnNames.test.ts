/**
 * 中文名表：解析容错、TTL、条件请求与失败回退
 * @author IsCibocaz
 * @since 1.15.0
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { FetchOptions } from "../../src/infra/download.ts";
import type { BufferResponse } from "../../src/infra/http.ts";
import {
    CN_NAMES_TTL_MS,
    loadCnNames,
    parseCnNames,
    type NamesTransport,
} from "../../src/mod/index.ts";
import { cnNamesFile, setHome } from "../../src/platform/index.ts";

const T0 = Date.parse("2026-10-21T00:00:00Z");

const NETWORK: FetchOptions = {
    timeoutMs: 1000,
    retries: 0,
    proxy: null,
    noProxy: [],
    sources: [],
};

const TABLE = "3dskinlayers\t3D 皮肤层\nsodium\t钠\n";

async function withHome(body: () => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "bloomery-cn-names-"));
    setHome(home);
    try {
        await body();
    } finally {
        await rm(home, { recursive: true, force: true });
    }
}

function ok(body: string, headers: Record<string, string> = {}): BufferResponse {
    return { status: 200, headers, body: Buffer.from(body, "utf8") };
}

test("解析容错：TAB 与 | 都认，坏行跳过，重复取第一条", () => {
    const text = [
        "\uFEFF3dskinlayers\t3D 皮肤层",
        "sodium|钠",
        "",
        "# 注释",
        "broken-line",
        "empty\t",
        "multi\t第一列\t第三列",
        "sodium|重复",
        "crlf\tCRLF\r",
    ].join("\n");
    const names = parseCnNames(text);
    assert.deepEqual(
        [...names.entries()],
        [
            ["3dskinlayers", "3D 皮肤层"],
            ["sodium", "钠"],
            ["multi", "第一列"],
            ["crlf", "CRLF"],
        ],
    );
});

test("没有缓存时先拉一次，写进配置目录的 metadata/", async () => {
    await withHome(async () => {
        const calls: string[] = [];
        const transport: NamesTransport = async (url) => {
            calls.push(url);
            return ok(TABLE, { etag: '"v1"' });
        };

        const names = await loadCnNames({ network: NETWORK, transport, now: () => T0 });
        assert.equal(calls.length, 1);
        assert.equal(names.names.get("3dskinlayers"), "3D 皮肤层");
        assert.equal(names.info.count, 2);
        assert.equal(names.info.updatedAt, new Date(T0).toISOString());
        assert.equal(names.info.source, calls[0]);
        assert.equal(names.info.path, cnNamesFile());
        assert.equal(await readFile(cnNamesFile(), "utf8"), TABLE);
    });
});

test("TTL 内不再请求，到期后带条件请求，304 沿用缓存", async () => {
    await withHome(async () => {
        const headers: Array<Record<string, string>> = [];
        const transport: NamesTransport = async (_url, options) => {
            headers.push({ ...options.headers } as Record<string, string>);
            return headers.length === 1
                ? ok(TABLE, { etag: '"v1"' })
                : { status: 304, headers: {}, body: Buffer.alloc(0) };
        };

        const first = await loadCnNames({ network: NETWORK, transport, now: () => T0 });
        assert.equal(first.names.size, 2);

        // TTL 内：不发请求
        const second = await loadCnNames({
            network: NETWORK,
            transport,
            now: () => T0 + CN_NAMES_TTL_MS - 1000,
        });
        assert.equal(headers.length, 1);
        assert.equal(second.info.updatedAt, new Date(T0).toISOString());

        // 到期：带 If-None-Match，304 后仍用本地表，内容更新时间不变
        const third = await loadCnNames({
            network: NETWORK,
            transport,
            now: () => T0 + CN_NAMES_TTL_MS + 1000,
        });
        assert.equal(headers.length, 2);
        assert.equal(headers[1]?.["if-none-match"], '"v1"');
        assert.equal(third.names.get("sodium"), "钠");
        assert.equal(third.info.updatedAt, new Date(T0).toISOString());
    });
});

test("refresh 忽略 TTL，重新下载", async () => {
    await withHome(async () => {
        const calls: string[] = [];
        const transport: NamesTransport = async (url) => {
            calls.push(url);
            return calls.length === 1 ? ok(TABLE) : ok("sodium\t钠\n");
        };

        await loadCnNames({ network: NETWORK, transport, now: () => T0 });
        const refreshed = await loadCnNames({
            network: NETWORK,
            transport,
            refresh: true,
            now: () => T0 + 1000,
        });
        assert.equal(calls.length, 2);
        assert.equal(refreshed.names.size, 1);
        assert.equal(refreshed.info.updatedAt, new Date(T0 + 1000).toISOString());
    });
});

test("网络失败沿用上一份缓存，无缓存就是空表", async () => {
    await withHome(async () => {
        const broken: NamesTransport = async () => {
            throw new Error("ECONNREFUSED");
        };

        const empty = await loadCnNames({ network: NETWORK, transport: broken, now: () => T0 });
        assert.equal(empty.names.size, 0);
        assert.equal(empty.info.count, 0);
        assert.equal(empty.info.updatedAt, null);

        let calls = 0;
        const working: NamesTransport = async () => {
            calls += 1;
            return ok(TABLE);
        };
        const warmed = await loadCnNames({ network: NETWORK, transport: working, now: () => T0 });
        assert.equal(warmed.names.size, 2);

        const fallen = await loadCnNames({
            network: NETWORK,
            transport: broken,
            now: () => T0 + CN_NAMES_TTL_MS + 1000,
        });
        assert.equal(calls, 1);
        assert.equal(fallen.names.size, 2);
        assert.equal(fallen.info.updatedAt, new Date(T0).toISOString());
    });
});

test("offline 只读缓存，不发请求", async () => {
    await withHome(async () => {
        let calls = 0;
        const transport: NamesTransport = async () => {
            calls += 1;
            return ok(TABLE);
        };
        const names = await loadCnNames({
            network: NETWORK,
            transport,
            offline: true,
            now: () => T0,
        });
        assert.equal(calls, 0);
        assert.equal(names.names.size, 0);

        await loadCnNames({ network: NETWORK, transport, now: () => T0 });
        assert.equal(calls, 1);
        const cached = await loadCnNames({
            network: NETWORK,
            transport,
            offline: true,
            now: () => T0 + CN_NAMES_TTL_MS + 1000,
        });
        assert.equal(calls, 1);
        assert.equal(cached.names.get("sodium"), "钠");
    });
});
