/**
 * 补全：走 install 那四类通道，缺什么下什么，失败按可重试分类
 * @author IsCibocaz
 * @since 1.10.0
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DownloadSetting, Network } from "../../src/config/types.ts";
import { errorJson } from "../../src/error/handler.ts";
import { pathExists } from "../../src/infra/fs.ts";
import { parseDescriptor, type Descriptor } from "../../src/version/descriptor.ts";
import { installVersion, repairVersion } from "../../src/version/installer.ts";
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
const LIBRARY_BAD = Buffer.from("library-jar-corrupted");
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
    /** 库改回坏内容，制造校验不过 */
    breakLibrary(): void;
    /** 库返回 404，制造网络失败 */
    removeLibrary(): void;
}

// 版本清单、版本 json、客户端 jar、库、natives、资源全由本地服务提供
async function setup(): Promise<Fixture> {
    let base = "";
    let broken = false;
    let gone = false;
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
                if (gone) {
                    return { status: 404 };
                }
                return { status: 200, body: broken ? LIBRARY_BAD : LIBRARY_JAR };
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

    const root = await mkdtemp(join(tmpdir(), "bloomery-repair-"));
    const download: DownloadSetting = {
        verify: "strict",
        sources: [{ provider: "custom", enabled: true, url: server.url }],
    };
    return {
        root,
        server,
        download,
        breakLibrary: () => {
            broken = true;
        },
        removeLibrary: () => {
            gone = true;
        },
    };
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
            ...["natives-linux", "natives-windows", "natives-macos"].map((classifier) => ({
                name: `d.e:f:1.0:${classifier}`,
                downloads: {
                    classifiers: {
                        [classifier]: {
                            sha1: sha1(NATIVES_JAR),
                            size: NATIVES_JAR.length,
                            url: `${base}/natives.jar`,
                        },
                    },
                },
            })),
        ],
    };
}

async function close(fixture: Fixture): Promise<void> {
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
}

async function readDescriptorOf(fixture: Fixture): Promise<Descriptor> {
    const jsonPath = join(fixture.root, "versions", "t", "t.json");
    const raw: unknown = JSON.parse(await readFile(jsonPath, "utf8"));
    const descriptor = parseDescriptor(raw, jsonPath, "t", jsonPath);
    assert.ok(descriptor !== undefined);
    return descriptor;
}

async function install(fixture: Fixture): Promise<void> {
    await installVersion({
        folderPath: fixture.root,
        versionId: "t",
        network: NETWORK,
        download: fixture.download,
    });
}

function repairInput(fixture: Fixture, descriptor: Descriptor, assets: boolean) {
    return {
        folderPath: fixture.root,
        name: "t",
        versionDirectory: join(fixture.root, "versions", "t"),
        descriptor,
        clientJar: join(fixture.root, "versions", "t", "t.jar"),
        assets,
        network: NETWORK,
        download: fixture.download,
    };
}

const CLIENT = join("versions", "t", "t.jar");
const LIBRARY = join("libraries", "a", "b", "c", "1.0", "c-1.0.jar");
const NATIVES_ROOT = join("libraries", "d");
const ASSET = join("assets", "objects", ASSET_HASH.slice(0, 2), ASSET_HASH);

test("删掉客户端 jar、库、natives 后补回来", async () => {
    const fixture = await setup();
    try {
        await install(fixture);
        const descriptor = await readDescriptorOf(fixture);

        await rm(join(fixture.root, CLIENT));
        await rm(join(fixture.root, LIBRARY));
        await rm(join(fixture.root, NATIVES_ROOT), { recursive: true, force: true });

        const report = await repairVersion(repairInput(fixture, descriptor, true));

        assert.equal(report.name, "t");
        assert.equal(report.clientJar.downloaded, 1);
        assert.equal(report.libraries.downloaded, 1);
        assert.equal(report.natives.report.downloaded, 1);
        assert.deepEqual(report.warnings, []);

        assert.equal(await readFile(join(fixture.root, CLIENT), "utf8"), "client-jar");
        assert.equal(await readFile(join(fixture.root, LIBRARY), "utf8"), "library-jar");
        assert.equal(await pathExists(join(fixture.root, NATIVES_ROOT)), true);
    } finally {
        await close(fixture);
    }
});

test("没有缺件时一个文件都不下", async () => {
    const fixture = await setup();
    try {
        await install(fixture);
        const descriptor = await readDescriptorOf(fixture);

        const report = await repairVersion(repairInput(fixture, descriptor, true));

        assert.equal(report.clientJar.downloaded, 0);
        assert.equal(report.libraries.downloaded, 0);
        assert.equal(report.natives.report.downloaded, 0);
        assert.equal(report.libraries.skipped, 1);
        assert.equal(report.natives.report.skipped, 1);
    } finally {
        await close(fixture);
    }
});

test("资源对象缺了也补", async () => {
    const fixture = await setup();
    try {
        await install(fixture);
        const descriptor = await readDescriptorOf(fixture);
        await rm(join(fixture.root, ASSET));

        const report = await repairVersion(repairInput(fixture, descriptor, true));

        assert.equal(report.assets?.objects.downloaded, 1);
        assert.equal(await readFile(join(fixture.root, ASSET), "utf8"), "asset-bytes");
    } finally {
        await close(fixture);
    }
});

test("资源索引整份不在时连索引一起补", async () => {
    const fixture = await setup();
    try {
        await install(fixture);
        const descriptor = await readDescriptorOf(fixture);
        await rm(join(fixture.root, "assets"), { recursive: true, force: true });

        const report = await repairVersion(repairInput(fixture, descriptor, true));

        assert.equal(report.assets?.index.downloaded, 1);
        assert.equal(report.assets?.objects.downloaded, 1);
        assert.equal(await pathExists(join(fixture.root, "assets", "indexes", "t.json")), true);
        assert.equal(await readFile(join(fixture.root, ASSET), "utf8"), "asset-bytes");
    } finally {
        await close(fixture);
    }
});

test("库下不下来时报 DependencyMissing，可重试", async () => {
    const fixture = await setup();
    try {
        await install(fixture);
        const descriptor = await readDescriptorOf(fixture);
        await rm(join(fixture.root, LIBRARY));
        fixture.removeLibrary();

        await assert.rejects(
            repairVersion(repairInput(fixture, descriptor, true)),
            (error: unknown) => {
                const app = error as { code?: string; context?: Record<string, string> };
                assert.equal(app.code, "DependencyMissing");
                assert.match(String(app.context?.["first"]), /c-1\.0\.jar/);
                const envelope = errorJson(error) as { error: { retryable: boolean } };
                assert.equal(envelope.error.retryable, true);
                return true;
            },
        );
    } finally {
        await close(fixture);
    }
});

test("文件校验不过时报 InstallBroken，不可重试", async () => {
    const fixture = await setup();
    try {
        await install(fixture);
        const descriptor = await readDescriptorOf(fixture);
        await rm(join(fixture.root, LIBRARY));
        fixture.breakLibrary();

        await assert.rejects(
            repairVersion(repairInput(fixture, descriptor, true)),
            (error: unknown) => {
                const app = error as { code?: string; context?: Record<string, string> };
                assert.equal(app.code, "InstallBroken");
                assert.match(String(app.context?.["first"]), /sha1 不符/);
                const envelope = errorJson(error) as { error: { retryable: boolean } };
                assert.equal(envelope.error.retryable, false);
                return true;
            },
        );
    } finally {
        await close(fixture);
    }
});
