/**
 * 已装 MOD 列表：扫盘、sha1 与反查回退
 * @author IsCibocaz
 * @since 1.13.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AppError } from "../../src/error/index.ts";
import type { TransferOptions } from "../../src/infra/download.ts";
import { listInstalledMods, scanMods, sha1Of } from "../../src/mod/index.ts";
import type { Transport } from "../../src/mod/index.ts";

const SOURCE = { provider: "official" as const, rewrite: (url: string) => url };

const NETWORK: TransferOptions = {
    timeoutMs: 1000,
    retries: 0,
    proxy: null,
    noProxy: [],
    verify: "off",
    concurrency: 1,
    sources: [SOURCE],
};

const VERSION = {
    id: "v1",
    project_id: "AANobbMI",
    name: "0.5.3",
    version_number: "mc1.20.1-0.5.3",
    version_type: "release",
    game_versions: ["1.20.1"],
    loaders: ["fabric"],
    date_published: "2026-01-01T00:00:00Z",
    files: [],
    dependencies: [],
};

const PROJECT = { id: "AANobbMI", slug: "sodium", title: "Sodium" };

// 404 走 fetchBuffer 那套包装：状态码在 cause 链上
function notFound(url: string): AppError {
    const inner = Object.assign(new Error("HTTP 404"), { status: 404 });
    return new AppError("download", "DownloadFailed", { cause: inner, context: { detail: url } });
}

function fakeTransport(
    calls: string[],
    routes: {
        readonly lookup?: unknown;
        readonly lookupStatus?: number;
        readonly projects?: unknown;
        readonly projectsFail?: boolean;
    },
): Transport {
    return async (url: string) => {
        calls.push(url);
        if (url.includes("/version_file/")) {
            if (routes.lookupStatus !== undefined) {
                throw notFound(url);
            }
            return Buffer.from(JSON.stringify(routes.lookup ?? VERSION));
        }
        if (url.includes("/projects?")) {
            if (routes.projectsFail === true) {
                throw new AppError("download", "DownloadFailed", { context: { detail: url } });
            }
            return Buffer.from(JSON.stringify(routes.projects ?? [PROJECT]));
        }
        throw new AppError("download", "DownloadFailed", { context: { detail: url } });
    };
}

async function withMods(
    names: readonly string[],
    body: (directory: string) => Promise<void>,
): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-mod-list-"));
    const mods = join(root, "mods");
    await mkdir(mods, { recursive: true });
    for (const name of names) {
        await writeFile(join(mods, name), `jar:${name}`);
    }
    try {
        await body(mods);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("只认 jar 与 .jar.disabled，顺序稳定", async () => {
    await withMods(["b.jar", "a.jar.disabled", "notes.txt", "c.jar"], async (mods) => {
        const scanned = await scanMods(mods);
        assert.deepEqual(
            scanned.map((one) => [one.filename, one.enabled]),
            [
                ["a.jar.disabled", false],
                ["b.jar", true],
                ["c.jar", true],
            ],
        );
    });
});

test("目录不存在就是空列表，不报错", async () => {
    assert.deepEqual(await scanMods(join(tmpdir(), "bloomery-no-such-mods-dir")), []);
});

test("sha1 按文件内容算，读不到给 null", async () => {
    await withMods(["a.jar"], async (mods) => {
        const digest = await sha1Of(join(mods, "a.jar"));
        assert.equal(digest?.length, 40);
        assert.equal(await sha1Of(join(mods, "nope.jar")), null);
    });
});

test("offline 不联网，sha1 照算但一律未识别", async () => {
    await withMods(["sodium.jar"], async (mods) => {
        const calls: string[] = [];
        const files = await listInstalledMods({
            modsDirectory: mods,
            network: NETWORK,
            offline: true,
            transport: fakeTransport(calls, {}),
        });
        assert.equal(calls.length, 0);
        assert.equal(files.length, 1);
        assert.equal(files[0]?.resolved, false);
        assert.equal(files[0]?.project, null);
        assert.equal(files[0]?.version, null);
        assert.equal(files[0]?.sha1?.length, 40);
    });
});

test("联网反查：sha1 取版本，project_id 批量换标题", async () => {
    await withMods(["sodium.jar", "lithium.jar.disabled"], async (mods) => {
        const calls: string[] = [];
        const seen: Array<readonly [number, number]> = [];
        const files = await listInstalledMods({
            modsDirectory: mods,
            network: NETWORK,
            transport: fakeTransport(calls, {}),
            onResolve: (done, total) => seen.push([done, total]),
        });

        assert.equal(files.length, 2);
        const sodium = files.find((one) => one.filename === "sodium.jar");
        const lithium = files.find((one) => one.filename === "lithium.jar.disabled");
        assert.equal(sodium?.resolved, true);
        assert.equal(sodium?.project?.slug, "sodium");
        assert.equal(sodium?.project?.title, "Sodium");
        assert.equal(sodium?.version?.number, "mc1.20.1-0.5.3");
        assert.equal(lithium?.enabled, false);
        assert.equal(lithium?.resolved, true);
        // 每个文件一次 sha1 反查，项目标题只问一批
        assert.equal(calls.filter((url) => url.includes("/version_file/")).length, 2);
        assert.equal(calls.filter((url) => url.includes("/projects?")).length, 1);
        assert.equal(seen[0]?.[0], 0);
        assert.equal(seen.at(-1)?.[0], 2);
    });
});

test("没发布过的 jar 退回文件名，其余条目不受影响", async () => {
    await withMods(["a.jar", "b.jar"], async (mods) => {
        let index = 0;
        const transport: Transport = async (url: string) => {
            if (url.includes("/projects?")) {
                return Buffer.from(JSON.stringify([PROJECT]));
            }
            index += 1;
            if (index === 1) {
                throw notFound(url);
            }
            return Buffer.from(JSON.stringify(VERSION));
        };

        const files = await listInstalledMods({ modsDirectory: mods, network: NETWORK, transport });
        assert.equal(files[0]?.resolved, false);
        assert.equal(files[0]?.project, null);
        assert.equal(files[0]?.version, null);
        assert.equal(files[1]?.resolved, true);
    });
});

test("项目批量接口失败时只丢标题，版本仍在", async () => {
    await withMods(["a.jar"], async (mods) => {
        const files = await listInstalledMods({
            modsDirectory: mods,
            network: NETWORK,
            transport: fakeTransport([], { projectsFail: true }),
        });
        assert.equal(files[0]?.resolved, false);
        assert.equal(files[0]?.project, null);
        assert.equal(files[0]?.version?.id, "v1");
    });
});
