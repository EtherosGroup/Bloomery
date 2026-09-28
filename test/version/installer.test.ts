/**
 * 安装：客户端 jar、库、natives、资源，以及重复安装时的跳过
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { DownloadSetting, Network } from "../../src/config/types.ts";
import { pathExists } from "../../src/infra/fs.ts";
import { installVersion } from "../../src/version/installer.ts";
import { serve, zipOf } from "../helpers/server.ts";

const NETWORK: Network = {
    proxy: null,
    noProxy: [],
    timeoutMs: 5000,
    retries: 1,
    concurrency: 4,
};

function sha1(data: Buffer): string {
    return createHash("sha1").update(data).digest("hex");
}

test("从零装一个版本，再装一次全部跳过", async () => {
    const clientJar = Buffer.from("client-jar");
    const libraryJar = Buffer.from("library-jar");
    // natives jar 里带着目录层级，解出来要平铺
    const nativesJar = zipOf([
        { name: "META-INF/MANIFEST.MF", data: "meta" },
        { name: "linux/x64/libtest.so", data: "so-bytes" },
    ]);
    const assetObject = Buffer.from("asset-bytes");
    const assetHash = sha1(assetObject);
    const index = Buffer.from(
        JSON.stringify({
            id: "t",
            objects: { "minecraft/x.txt": { hash: assetHash, size: assetObject.length } },
        }),
    );

    const server = await serve(({ path }) => {
        switch (path) {
            case "/client.jar":
                return { status: 200, body: clientJar };
            case "/libs/c-1.0.jar":
                return { status: 200, body: libraryJar };
            case "/natives.jar":
                return { status: 200, body: nativesJar };
            case "/indexes/t.json":
                return { status: 200, body: index };
            case `/assets/${assetHash.slice(0, 2)}/${assetHash}`:
                return { status: 200, body: assetObject };
            default:
                return { status: 404 };
        }
    });

    const root = await mkdtemp(join(tmpdir(), "bloomery-install-"));
    try {
        const versionJson = {
            id: "t",
            type: "release",
            mainClass: "com.example.Main",
            assets: "t",
            assetIndex: {
                id: "t",
                sha1: sha1(index),
                size: index.length,
                url: `${server.url}/indexes/t.json`,
            },
            downloads: {
                client: {
                    sha1: sha1(clientJar),
                    size: clientJar.length,
                    url: `${server.url}/client.jar`,
                },
            },
            libraries: [
                {
                    name: "a.b:c:1.0",
                    downloads: {
                        artifact: {
                            sha1: sha1(libraryJar),
                            size: libraryJar.length,
                            url: `${server.url}/libs/c-1.0.jar`,
                        },
                    },
                },
                {
                    name: "d.e:f:1.0:natives-linux",
                    downloads: {
                        classifiers: {
                            "natives-linux": {
                                sha1: sha1(nativesJar),
                                size: nativesJar.length,
                                url: `${server.url}/natives.jar`,
                            },
                        },
                    },
                },
            ],
        };
        await mkdir(join(root, "versions", "t"), { recursive: true });
        await writeFile(join(root, "versions", "t", "t.json"), JSON.stringify(versionJson));

        // 用 custom 镜像把资源对象的地址引到本地服务上，顺带验证镜像改写
        const download: DownloadSetting = {
            verify: "strict",
            sources: [{ provider: "custom", enabled: true, url: server.url }],
        };
        const input = { folderPath: root, versionId: "t", network: NETWORK, download };

        const first = await installVersion(input);
        assert.equal(first.json, "present");
        assert.equal(first.clientJar, true);
        assert.deepEqual(first.warnings, []);
        assert.equal(first.libraries.downloaded, 1);
        assert.equal(first.natives.report.downloaded, 1);
        assert.equal(first.natives.files, 1);
        assert.equal(first.assets?.objects.downloaded, 1);

        assert.equal(await readFile(join(root, "versions", "t", "t.jar"), "utf8"), "client-jar");
        assert.equal(
            await readFile(join(root, "libraries", "a", "b", "c", "1.0", "c-1.0.jar"), "utf8"),
            "library-jar",
        );
        assert.equal(
            await readFile(join(root, "versions", "t", "natives", "libtest.so"), "utf8"),
            "so-bytes",
        );
        assert.equal(
            await readFile(
                join(root, "assets", "objects", assetHash.slice(0, 2), assetHash),
                "utf8",
            ),
            "asset-bytes",
        );
        assert.equal(await pathExists(join(root, "assets", "indexes", "t.json")), true);

        // 第二次：全部已存在，一个请求都不用发
        const before = server.seen.length;
        const second = await installVersion(input);
        assert.equal(second.libraries.downloaded, 0);
        assert.equal(second.libraries.skipped, 1);
        assert.equal(second.natives.report.downloaded, 0);
        assert.equal(second.assets?.objects.skipped, 1);
        assert.equal(server.seen.length, before);
    } finally {
        await server.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("版本 json 不在时报出来", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-install-"));
    try {
        // 只建空目录，取清单要联网，这里只验证本地路径下的失败形态
        await assert.rejects(
            installVersion({
                folderPath: root,
                versionId: "没有这个版本",
                network: { ...NETWORK, retries: 0, timeoutMs: 1500 },
                download: {
                    verify: "strict",
                    sources: [{ provider: "official", enabled: true, url: null }],
                },
            }),
        );
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
