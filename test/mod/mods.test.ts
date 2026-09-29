/**
 * MOD 层：检索解析、版本匹配与安装
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { AppError } from "../../src/error/index.ts";
import type { DownloadTask, TransferOptions } from "../../src/infra/download.ts";
import {
    installMod,
    listVersions,
    pickVersion,
    projectOf,
    searchMods,
} from "../../src/mod/index.ts";
import type { ModVersion, Transport } from "../../src/mod/index.ts";

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

const API = "https://api.modrinth.com/v2";

const PROJECT = {
    project_id: "AANobbMI",
    slug: "sodium",
    title: "Sodium",
    description: "现代渲染优化",
    downloads: 232_806_602,
    categories: ["optimization", "fabric", "quilt"],
    versions: ["1.20.6", "1.21"],
};

function version(id: string, type: string, number: string, published: string): unknown {
    return {
        id,
        project_id: "AANobbMI",
        name: number,
        version_number: number,
        version_type: type,
        game_versions: ["1.20.6"],
        loaders: ["fabric"],
        date_published: published,
        files: [
            {
                url: `https://cdn.modrinth.com/${id}.jar`,
                filename: `sodium-${number}.jar`,
                size: 1000,
                primary: true,
                hashes: { sha1: "abc" },
            },
        ],
        dependencies: [],
    };
}

// 按路径分派，顺便记录请求过的 URL
function fakeTransport(
    calls: string[],
    routes: {
        readonly search?: unknown;
        readonly project?: unknown;
        readonly projectStatus?: number;
        readonly versions?: unknown;
        readonly single?: unknown;
    },
): Transport {
    return async (url: string) => {
        calls.push(url);
        if (url.includes("/search")) {
            return Buffer.from(JSON.stringify(routes.search ?? { hits: [] }));
        }
        if (url.includes("/version/") && !url.includes("/version?")) {
            return Buffer.from(JSON.stringify(routes.single ?? {}));
        }
        if (url.includes("/version?")) {
            return Buffer.from(JSON.stringify(routes.versions ?? []));
        }
        if (routes.projectStatus !== undefined && routes.projectStatus >= 400) {
            const inner = Object.assign(new Error(`HTTP ${routes.projectStatus}`), {
                status: routes.projectStatus,
            });
            // 真实实现里 fetchBuffer 会把状态码包进 cause
            throw new AppError("download", "DownloadFailed", {
                cause: inner,
                context: { detail: url },
            });
        }
        return Buffer.from(JSON.stringify(routes.project ?? PROJECT));
    };
}

test("搜索把 categories 里的加载器认出来", async () => {
    const calls: string[] = [];
    const hits = await searchMods("sodium", {
        network: NETWORK,
        limit: 3,
        transport: fakeTransport(calls, { search: { hits: [PROJECT] } }),
    });

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.id, "AANobbMI");
    assert.equal(hits[0]?.title, "Sodium");
    assert.deepEqual(hits[0]?.loaders, ["fabric", "quilt"]);
    assert.deepEqual(hits[0]?.gameVersions, ["1.20.6", "1.21"]);
    assert.match(calls[0] ?? "", /limit=3/);
});

test("版本列表把加载器与游戏版本带给服务端", async () => {
    const calls: string[] = [];
    const versions = await listVersions(
        "sodium",
        { gameVersion: "1.20.6", loader: "fabric" },
        {
            network: NETWORK,
            transport: fakeTransport(calls, {
                versions: [version("v1", "release", "1.0", "2026-01-01T00:00:00Z")],
            }),
        },
    );

    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.file?.filename, "sodium-1.0.jar");
    const query = decodeURIComponent(calls[0] ?? "");
    assert.match(query, /loaders=\["fabric"\]/);
    assert.match(query, /game_versions=\["1\.20\.6"\]/);
});

test("正式版优先，同级取发布最晚的", () => {
    const versions = [
        { versionType: "beta", published: "2026-06-01T00:00:00Z" },
        { versionType: "release", published: "2026-01-01T00:00:00Z" },
        { versionType: "release", published: "2026-05-01T00:00:00Z" },
    ] as unknown as readonly ModVersion[];

    assert.equal(pickVersion(versions)?.published, "2026-05-01T00:00:00Z");
    assert.equal(pickVersion([]), undefined);
});

test("项目取不到返回 undefined，而不是抛错", async () => {
    const calls: string[] = [];
    const found = await projectOf("nope", {
        network: NETWORK,
        transport: fakeTransport(calls, { projectStatus: 404 }),
    });
    assert.equal(found, undefined);
});

test("vanilla 与认不出游戏版本时拒绝安装", async () => {
    const calls: string[] = [];
    const transport = fakeTransport(calls, {});

    await assert.rejects(
        installMod({
            query: "sodium",
            modsDirectory: "/tmp/nowhere",
            gameVersion: "1.20.6",
            loader: null,
            network: NETWORK,
            withDependencies: true,
            transport,
        }),
        (error: unknown) => {
            assert.ok(error instanceof AppError);
            assert.equal(error.code, "ModUnsupported");
            return true;
        },
    );

    await assert.rejects(
        installMod({
            query: "sodium",
            modsDirectory: "/tmp/nowhere",
            gameVersion: null,
            loader: "fabric",
            network: NETWORK,
            withDependencies: true,
            transport,
        }),
        (error: unknown) => {
            assert.ok(error instanceof AppError);
            assert.equal(error.code, "ModUnsupported");
            return true;
        },
    );
});

test("安装写进 mods/，已存在的文件跳过", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-mod-install-"));
    try {
        const written: string[] = [];
        const download = async (task: DownloadTask) => {
            const exists = written.includes(task.target);
            if (!exists) {
                await mkdir(dirname(task.target), { recursive: true });
                await writeFile(task.target, "jar");
                written.push(task.target);
            }
            return {
                target: task.target,
                bytes: exists ? 0 : 3,
                status: exists ? ("skipped" as const) : ("downloaded" as const),
            };
        };

        const input = {
            query: "sodium",
            modsDirectory: root,
            gameVersion: "1.20.6",
            loader: "fabric",
            network: NETWORK,
            withDependencies: true,
            transport: fakeTransport([], {
                versions: [version("v1", "release", "1.0", "2026-01-01T00:00:00Z")],
            }),
            download,
        };

        const first = await installMod(input);
        assert.equal(first.project.slug, "sodium");
        assert.equal(first.version.number, "1.0");
        assert.equal(first.files.length, 1);
        assert.equal(first.files[0]?.filename, "sodium-1.0.jar");
        assert.equal(first.files[0]?.skipped, false);

        const again = await installMod(input);
        assert.equal(again.files[0]?.skipped, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("加 --deps 时装必需依赖，不加就只记一条提示", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-mod-deps-"));
    try {
        const withDep = version("v1", "release", "1.0", "2026-01-01T00:00:00Z") as {
            dependencies: unknown[];
        };
        withDep.dependencies = [
            { project_id: "P7dR8mSH", version_id: null, dependency_type: "required" },
        ];

        const routes = {
            versions: [withDep],
            single: {
                ...(version("dep-1", "release", "0.90", "2026-01-01T00:00:00Z") as object),
                project_id: "P7dR8mSH",
            },
        };
        const download = async (task: DownloadTask) => {
            await mkdir(dirname(task.target), { recursive: true });
            await writeFile(task.target, "jar");
            return { target: task.target, bytes: 3, status: "downloaded" as const };
        };
        const base = {
            query: "sodium",
            modsDirectory: root,
            gameVersion: "1.20.6",
            loader: "fabric",
            network: NETWORK,
            transport: fakeTransport([], routes),
            download,
        };

        const withDependencies = await installMod({ ...base, withDependencies: true });
        assert.equal(withDependencies.files.length, 2);
        assert.equal(withDependencies.dependencies[0]?.requirement, "必需，已装");

        const without = await installMod({ ...base, withDependencies: false });
        assert.equal(without.files.length, 1);
        assert.match(without.dependencies[0]?.requirement ?? "", /--deps/);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("dry-run 只算不落盘", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-mod-dry-"));
    try {
        let called = 0;
        const report = await installMod({
            query: "sodium",
            modsDirectory: root,
            gameVersion: "1.20.6",
            loader: "fabric",
            network: NETWORK,
            withDependencies: false,
            dryRun: true,
            transport: fakeTransport([], {
                versions: [version("v1", "release", "1.0", "2026-01-01T00:00:00Z")],
            }),
            download: async (task: DownloadTask) => {
                called += 1;
                return { target: task.target, bytes: 0, status: "skipped" as const };
            },
        });

        assert.equal(called, 0);
        assert.equal(report.files.length, 1);
        assert.equal(report.files[0]?.skipped, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
