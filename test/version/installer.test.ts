/**
 * 安装：重名拒绝、--name、客户端 jar、库、natives、资源
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DownloadSetting, Network } from "../../src/config/types.ts";
import { pathExists } from "../../src/infra/fs.ts";
import { installVersion } from "../../src/version/installer.ts";
import { defaultVersionName, parseLoaderSpec } from "../../src/version/loader.ts";
import { serve, zipOf, type TestServer } from "../helpers/server.ts";

const NETWORK: Network = {
    proxy: null,
    noProxy: [],
    timeoutMs: 5000,
    retries: 1,
    concurrency: 4,
};

const CLIENT_JAR = Buffer.from("client-jar");
const LIBRARY_JAR = Buffer.from("library-jar");
// natives jar 里带着目录层级，解出来要平铺
const NATIVES_JAR = zipOf([
    { name: "META-INF/MANIFEST.MF", data: "meta" },
    { name: "linux/x64/libtest.so", data: "so-bytes" },
]);
const ASSET_OBJECT = Buffer.from("asset-bytes");

function sha1(data: Buffer): string {
    return createHash("sha1").update(data).digest("hex");
}

const ASSET_HASH = sha1(ASSET_OBJECT);
const ASSET_INDEX = Buffer.from(
    JSON.stringify({
        id: "t",
        objects: { "minecraft/x.txt": { hash: ASSET_HASH, size: ASSET_OBJECT.length } },
    }),
);

interface Fixture {
    readonly root: string;
    readonly server: TestServer;
    readonly download: DownloadSetting;
}

// 版本清单、版本 json、客户端 jar、库、natives、资源全由本地服务提供
async function setup(): Promise<Fixture> {
    let base = "";
    const server = await serve(({ path }) => {
        switch (path) {
            case "/mc/game/version_manifest_v2.json":
                return {
                    status: 200,
                    body: JSON.stringify({
                        latest: { release: "t", snapshot: "t" },
                        versions: [{ id: "t", type: "release", url: `${base}/versions/t.json` }],
                    }),
                };
            case "/versions/t.json":
                return { status: 200, body: JSON.stringify(versionJson(base)) };
            case "/client.jar":
                return { status: 200, body: CLIENT_JAR };
            case "/libs/c-1.0.jar":
                return { status: 200, body: LIBRARY_JAR };
            case "/natives.jar":
                return { status: 200, body: NATIVES_JAR };
            case "/indexes/t.json":
                return { status: 200, body: ASSET_INDEX };
            case `/assets/${ASSET_HASH.slice(0, 2)}/${ASSET_HASH}`:
                return { status: 200, body: ASSET_OBJECT };
            default:
                return { status: 404 };
        }
    });
    base = server.url;

    const root = await mkdtemp(join(tmpdir(), "bloomery-install-"));
    // custom 源：Mojang 的地址会被引到本地，非 Mojang 的保持原样
    const download: DownloadSetting = {
        verify: "strict",
        sources: [{ provider: "custom", enabled: true, url: server.url }],
    };
    return { root, server, download };
}

function versionJson(base: string): unknown {
    return {
        id: "t",
        type: "release",
        mainClass: "com.example.Main",
        assets: "t",
        assetIndex: {
            id: "t",
            sha1: sha1(ASSET_INDEX),
            size: ASSET_INDEX.length,
            url: `${base}/indexes/t.json`,
        },
        downloads: {
            client: {
                sha1: sha1(CLIENT_JAR),
                size: CLIENT_JAR.length,
                url: `${base}/client.jar`,
            },
        },
        libraries: [
            {
                name: "a.b:c:1.0",
                downloads: {
                    artifact: {
                        sha1: sha1(LIBRARY_JAR),
                        size: LIBRARY_JAR.length,
                        url: `${base}/libs/c-1.0.jar`,
                    },
                },
            },
            {
                name: "d.e:f:1.0:natives-linux",
                downloads: {
                    classifiers: {
                        "natives-linux": {
                            sha1: sha1(NATIVES_JAR),
                            size: NATIVES_JAR.length,
                            url: `${base}/natives.jar`,
                        },
                    },
                },
            },
        ],
    };
}

async function close(fixture: Fixture): Promise<void> {
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
}

test("从零装一个版本", async () => {
    const fixture = await setup();
    try {
        const report = await installVersion({
            folderPath: fixture.root,
            versionId: "t",
            network: NETWORK,
            download: fixture.download,
        });

        // 不带加载器时名字就是版本号
        assert.equal(report.name, "t");
        assert.equal(report.loader, null);
        assert.equal(report.base, "none");
        assert.equal(report.clientJar, true);
        assert.deepEqual(report.warnings, []);
        assert.equal(report.libraries.downloaded, 1);
        assert.equal(report.natives.report.downloaded, 1);
        assert.equal(report.natives.files, 1);
        assert.equal(report.assets?.objects.downloaded, 1);

        assert.equal(
            await readFile(join(fixture.root, "versions", "t", "t.jar"), "utf8"),
            "client-jar",
        );
        assert.equal(
            await readFile(
                join(fixture.root, "libraries", "a", "b", "c", "1.0", "c-1.0.jar"),
                "utf8",
            ),
            "library-jar",
        );
        assert.equal(
            await readFile(join(fixture.root, "versions", "t", "natives", "libtest.so"), "utf8"),
            "so-bytes",
        );
        assert.equal(
            await readFile(
                join(fixture.root, "assets", "objects", ASSET_HASH.slice(0, 2), ASSET_HASH),
                "utf8",
            ),
            "asset-bytes",
        );
        assert.equal(await pathExists(join(fixture.root, "assets", "indexes", "t.json")), true);
    } finally {
        await close(fixture);
    }
});

test("重名再装被拒", async () => {
    const fixture = await setup();
    try {
        const input = {
            folderPath: fixture.root,
            versionId: "t",
            network: NETWORK,
            download: fixture.download,
        };
        await installVersion(input);

        await assert.rejects(installVersion(input), (error: unknown) => {
            assert.equal((error as { code?: string }).code, "VersionExists");
            assert.match(
                String((error as { context?: { text?: string } }).context?.text),
                /已经存在名为“t”的版本/,
            );
            return true;
        });
    } finally {
        await close(fixture);
    }
});

test("--name 决定目录名与显示名", async () => {
    const fixture = await setup();
    try {
        const report = await installVersion({
            folderPath: fixture.root,
            versionId: "t",
            name: "我的整合",
            network: NETWORK,
            download: fixture.download,
        });

        assert.equal(report.name, "我的整合");
        const json = JSON.parse(
            await readFile(join(fixture.root, "versions", "我的整合", "我的整合.json"), "utf8"),
        ) as { id: string };
        // json 的 id 跟着目录名走，启动时按 id 找 jar 才对得上
        assert.equal(json.id, "我的整合");
        assert.equal(
            await pathExists(join(fixture.root, "versions", "我的整合", "我的整合.jar")),
            true,
        );
    } finally {
        await close(fixture);
    }
});

test("版本名不能含路径分隔符", async () => {
    const fixture = await setup();
    try {
        await assert.rejects(
            installVersion({
                folderPath: fixture.root,
                versionId: "t",
                name: "../逃出去",
                network: NETWORK,
                download: fixture.download,
            }),
            (error: unknown) => (error as { code?: string }).code === "UsageError",
        );
    } finally {
        await close(fixture);
    }
});

test("加载器写法与默认命名", () => {
    assert.deepEqual(parseLoaderSpec("fabric@0.17.2"), { name: "fabric", version: "0.17.2" });
    assert.deepEqual(parseLoaderSpec("fabric@latest"), { name: "fabric", version: null });
    assert.deepEqual(parseLoaderSpec("fabric"), { name: "fabric", version: null });
    assert.deepEqual(parseLoaderSpec("Fabric@1.0"), { name: "fabric", version: "1.0" });
    assert.deepEqual(parseLoaderSpec("forge@47.4.16"), { name: "forge", version: "47.4.16" });
    assert.equal(parseLoaderSpec("optifine"), undefined);

    // 目录名与显示名：不带加载器就是版本号，带加载器接在后面
    assert.equal(defaultVersionName("1.20.6", null, null), "1.20.6");
    assert.equal(
        defaultVersionName("1.20.6", { name: "fabric", version: null }, "0.19.5"),
        "1.20.6-fabric-0.19.5",
    );
    assert.equal(
        defaultVersionName("1.20.6", { name: "forge", version: "47.4.16" }, "47.4.16"),
        "1.20.6-forge-47.4.16",
    );
});

test("没有这个版本时报出来", async () => {
    const fixture = await setup();
    try {
        await assert.rejects(
            installVersion({
                folderPath: fixture.root,
                versionId: "没有这个版本",
                network: NETWORK,
                download: fixture.download,
            }),
            (error: unknown) => (error as { code?: string }).code === "VersionNotFound",
        );
    } finally {
        await close(fixture);
    }
});
