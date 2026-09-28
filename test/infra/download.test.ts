/**
 * 下载：跳过已存在、sha1 校验、源回退、失败不留残渣
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { downloadOne, type TransferOptions } from "../../src/infra/download.ts";
import { sourcesOf, type Source } from "../../src/infra/source.ts";
import { serve } from "../helpers/server.ts";

const IDENTITY: readonly Source[] = [{ provider: "official", rewrite: (url) => url }];

function options(
    sources: readonly Source[],
    overrides: Partial<TransferOptions> = {},
): TransferOptions {
    return {
        timeoutMs: overrides.timeoutMs ?? 3000,
        retries: overrides.retries ?? 1,
        proxy: overrides.proxy ?? null,
        noProxy: overrides.noProxy ?? [],
        verify: overrides.verify ?? "strict",
        concurrency: overrides.concurrency ?? 2,
        sources,
    };
}

function sha1(data: Buffer): string {
    return createHash("sha1").update(data).digest("hex");
}

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-dl-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("下载并校验", async () => {
    const body = Buffer.from("文件内容");
    const server = await serve(() => ({ status: 200, body }));
    await inTemp(async (root) => {
        try {
            const target = join(root, "deep", "a.bin");
            const outcome = await downloadOne(
                { url: `${server.url}/a.bin`, target, sha1: sha1(body), size: body.length },
                options(IDENTITY),
            );
            assert.equal(outcome.status, "downloaded");
            assert.equal(outcome.bytes, body.length);
            assert.equal(await readFile(target, "utf8"), "文件内容");
        } finally {
            await server.close();
        }
    });
});

test("已经存在就跳过，连请求都不发", async () => {
    const server = await serve(() => ({ status: 200, body: "x" }));
    await inTemp(async (root) => {
        try {
            const target = join(root, "a.bin");
            await writeFile(target, "旧的");
            const outcome = await downloadOne(
                { url: `${server.url}/a.bin`, target, sha1: null, size: null },
                options(IDENTITY),
            );
            assert.equal(outcome.status, "skipped");
            assert.equal(server.hits.size, 0);
            assert.equal(await readFile(target, "utf8"), "旧的");
        } finally {
            await server.close();
        }
    });
});

test("sha1 不符：strict 报错，warn 与 off 放行", async () => {
    const server = await serve(() => ({ status: 200, body: "内容" }));
    await inTemp(async (root) => {
        try {
            const task = {
                url: `${server.url}/a.bin`,
                target: join(root, "a.bin"),
                sha1: "0".repeat(40),
                size: null,
            };
            await assert.rejects(downloadOne(task, options(IDENTITY, { verify: "strict" })));

            // 失败不能留下半个文件
            const leftovers = (await readdir(root)).filter((name) => name.includes(".part-"));
            assert.deepEqual(leftovers, []);

            const warned = await downloadOne(task, options(IDENTITY, { verify: "warn" }));
            assert.equal(warned.status, "downloaded");
            assert.equal(await readFile(task.target, "utf8"), "内容");

            await rm(task.target, { force: true });
            const off = await downloadOne(task, options(IDENTITY, { verify: "off" }));
            assert.equal(off.status, "downloaded");
        } finally {
            await server.close();
        }
    });
});

test("前一个源不通就换下一个", async () => {
    const server = await serve(() => ({ status: 200, body: "来自备用源" }));
    await inTemp(async (root) => {
        try {
            const dead = "http://127.0.0.1:1";
            const sources: readonly Source[] = [
                { provider: "official", rewrite: (url) => `${dead}${new URL(url).pathname}` },
                { provider: "custom", rewrite: (url) => `${server.url}${new URL(url).pathname}` },
            ];
            const target = join(root, "a.bin");
            const outcome = await downloadOne(
                { url: "http://example.invalid/a.bin", target, sha1: null, size: null },
                options(sources),
            );
            assert.equal(outcome.status, "downloaded");
            assert.equal(await readFile(target, "utf8"), "来自备用源");
        } finally {
            await server.close();
        }
    });
});

test("全部源都失败时报错", async () => {
    await inTemp(async (root) => {
        const sources: readonly Source[] = [
            { provider: "official", rewrite: () => "http://127.0.0.1:1/a.bin" },
        ];
        await assert.rejects(
            downloadOne(
                {
                    url: "http://example.invalid/a.bin",
                    target: join(root, "a.bin"),
                    sha1: null,
                    size: null,
                },
                options(sources, { retries: 0 }),
            ),
        );
    });
});

test("下载源改写", () => {
    const [official] = sourcesOf({
        verify: "strict",
        sources: [{ provider: "official", enabled: true, url: null }],
    });
    assert.ok(official !== undefined);
    const mojang = "https://libraries.minecraft.net/a/b/c.jar";
    assert.equal(official.rewrite(mojang), mojang);

    const [mirror] = sourcesOf({
        verify: "strict",
        sources: [{ provider: "bmclapi", enabled: true, url: null }],
    });
    assert.ok(mirror !== undefined);
    // 库加 /maven/，资源加 /assets/，piston 摆路径，版本 json 走专用入口
    assert.equal(mirror.rewrite(mojang), "https://bmclapi2.bangbang93.com/maven/a/b/c.jar");
    assert.equal(
        mirror.rewrite("https://resources.download.minecraft.net/ab/abcd"),
        "https://bmclapi2.bangbang93.com/assets/ab/abcd",
    );
    assert.equal(
        mirror.rewrite("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"),
        "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json",
    );
    assert.equal(
        mirror.rewrite("https://piston-meta.mojang.com/v1/packages/abc/1.20.6.json"),
        "https://bmclapi2.bangbang93.com/version/1.20.6/json",
    );
    // 不是 Mojang 的仓库不动
    assert.equal(
        mirror.rewrite("https://maven.minecraftforge.net/net/x/y.jar"),
        "https://maven.minecraftforge.net/net/x/y.jar",
    );

    // 全关掉时退回官方
    const [fallback] = sourcesOf({
        verify: "strict",
        sources: [{ provider: "bmclapi", enabled: false, url: null }],
    });
    assert.equal(fallback?.provider, "official");
});
