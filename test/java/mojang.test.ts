/**
 * Mojang 来源：按清单逐文件安装，目录、链接、可执行位、sha1
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readlink, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { TransferOptions } from "../../src/infra/download.ts";
import { pathExists } from "../../src/infra/fs.ts";
import { installMojangRuntime } from "../../src/java/mojang.ts";
import { mojangPlatform } from "../../src/java/providers.ts";
import { serve, type TestServer } from "../helpers/server.ts";

const JAVA = Buffer.from("#!/bin/sh\necho java\n");
const JAVA_EXE = Buffer.from("MZ java\n");
const RELEASE = Buffer.from("JAVA_VERSION=21\n");
const LICENSE = Buffer.from("license\n");

function sha1(data: Buffer): string {
    return createHash("sha1").update(data).digest("hex");
}

function indexJson(base: string, platform: string, manifestSha1: string): unknown {
    return {
        [platform]: {
            "java-runtime-delta": [
                {
                    manifest: {
                        url: `${base}/manifest.json`,
                        sha1: manifestSha1,
                        size: 1024,
                    },
                    version: { name: "21.0.7", released: "2025-05-19T08:30:12+00:00" },
                },
            ],
        },
    };
}

// hash 传 true 时 release 的 sha1 对不上正文
function manifestBody(base: string, broken: boolean): string {
    const file = (name: string, data: Buffer, executable: boolean): unknown => ({
        type: "file",
        executable,
        downloads: {
            raw: {
                url: `${base}/objects/${sha1(data)}/${name}`,
                sha1: sha1(data),
                size: data.length,
            },
        },
    });
    return JSON.stringify({
        files: {
            bin: { type: "directory" },
            legal: { type: "directory" },
            "legal/java.base": { type: "directory" },
            "legal/app": { type: "directory" },
            "bin/java": file("java", JAVA, true),
            "bin/java.exe": file("java.exe", JAVA_EXE, true),
            release: {
                type: "file",
                executable: false,
                downloads: {
                    raw: {
                        url: `${base}/objects/${sha1(RELEASE)}/release`,
                        sha1: broken ? "f".repeat(40) : sha1(RELEASE),
                        size: RELEASE.length,
                    },
                },
            },
            "legal/java.base/LICENSE": file("LICENSE", LICENSE, false),
            "legal/app/LICENSE": { type: "link", target: "../java.base/LICENSE" },
        },
    });
}

interface Fixture {
    readonly root: string;
    readonly server: TestServer;
    readonly index: string;
    readonly options: TransferOptions;
    readonly platform: string;
}

async function setup(broken = false, badManifestHash = false): Promise<Fixture> {
    const platform = mojangPlatform() ?? "linux";
    let base = "";
    const server = await serve(({ path }) => {
        switch (path) {
            case "/all.json": {
                const body = manifestBody(base, broken);
                const hash = badManifestHash ? "f".repeat(40) : sha1(Buffer.from(body));
                return { status: 200, body: JSON.stringify(indexJson(base, platform, hash)) };
            }
            case "/manifest.json":
                return { status: 200, body: manifestBody(base, broken) };
            case `/objects/${sha1(JAVA)}/java`:
                return { status: 200, body: JAVA };
            case `/objects/${sha1(JAVA_EXE)}/java.exe`:
                return { status: 200, body: JAVA_EXE };
            case `/objects/${sha1(RELEASE)}/release`:
                return { status: 200, body: RELEASE };
            case `/objects/${sha1(LICENSE)}/LICENSE`:
                return { status: 200, body: LICENSE };
            default:
                return { status: 404 };
        }
    });
    base = server.url;

    const root = await mkdtemp(join(tmpdir(), "bloomery-mojang-"));
    const options: TransferOptions = {
        timeoutMs: 5000,
        retries: 1,
        proxy: null,
        noProxy: [],
        verify: "strict",
        concurrency: 2,
        sources: [{ provider: "official", rewrite: (url) => url }],
    };
    return { root, server, index: `${base}/all.json`, options, platform };
}

async function close(fixture: Fixture): Promise<void> {
    await fixture.server.close();
    await rm(fixture.root, { recursive: true, force: true });
}

test("按清单装出目录、文件、链接与可执行位", async () => {
    const fixture = await setup();
    try {
        const report = await installMojangRuntime({
            major: 21,
            root: fixture.root,
            index: fixture.index,
            options: fixture.options,
        });

        assert.equal(report.provider, "mojang");
        assert.equal(report.component, "java-runtime-delta");
        assert.equal(report.version, "21.0.7");
        assert.equal(report.platform, fixture.platform);
        assert.equal(report.files, 4);
        assert.equal(report.bytes, JAVA.length + JAVA_EXE.length + RELEASE.length + LICENSE.length);
        assert.equal(report.directories, 4);
        assert.equal(report.links, 1);

        const root = join(fixture.root, "java-runtime-delta-21.0.7");
        assert.equal(report.root, root);
        assert.equal(await readFile(join(root, "release"), "utf8"), RELEASE.toString());

        const binary = process.platform === "win32" ? "bin/java.exe" : "bin/java";
        assert.equal(report.java, join(root, binary));
        assert.equal(await pathExists(report.java), true);

        const link = join(root, "legal", "app", "LICENSE");
        assert.equal((await lstat(link)).isSymbolicLink(), true);
        assert.equal(await readlink(link), "../java.base/LICENSE");
        assert.equal(await readFile(link, "utf8"), LICENSE.toString());

        if (process.platform !== "win32") {
            assert.notEqual((await stat(report.java)).mode & 0o111, 0);
            assert.equal((await stat(join(root, "release"))).mode & 0o111, 0);
        }
    } finally {
        await close(fixture);
    }
});

test("dry-run 只取索引与清单", async () => {
    const fixture = await setup();
    try {
        const report = await installMojangRuntime({
            major: 21,
            root: fixture.root,
            index: fixture.index,
            options: fixture.options,
            dryRun: true,
        });

        assert.equal(report.files, 4);
        assert.equal(await pathExists(join(fixture.root, "java-runtime-delta-21.0.7")), false);
        assert.deepEqual([...fixture.server.hits.keys()].sort(), ["/all.json", "/manifest.json"]);
    } finally {
        await close(fixture);
    }
});

test("重复安装被拒，--force 重装", async () => {
    const fixture = await setup();
    try {
        const input = {
            major: 21,
            root: fixture.root,
            index: fixture.index,
            options: fixture.options,
        };
        await installMojangRuntime(input);

        await assert.rejects(installMojangRuntime(input), (error: unknown) => {
            assert.equal((error as { code?: string }).code, "JavaDuplicate");
            return true;
        });

        const again = await installMojangRuntime({ ...input, force: true });
        assert.equal(again.files, 4);
    } finally {
        await close(fixture);
    }
});

test("主版本不在索引里时报 JavaNotFound", async () => {
    const fixture = await setup();
    try {
        await assert.rejects(
            installMojangRuntime({
                major: 22,
                root: fixture.root,
                index: fixture.index,
                options: fixture.options,
            }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, "JavaNotFound");
                assert.match(
                    String((error as { context?: { detail?: string } }).context?.detail),
                    /没有主版本 22/,
                );
                return true;
            },
        );
    } finally {
        await close(fixture);
    }
});

test("sha1 不符时报 InstallBroken", async () => {
    const fixture = await setup(true);
    try {
        await assert.rejects(
            installMojangRuntime({
                major: 21,
                root: fixture.root,
                index: fixture.index,
                options: fixture.options,
            }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, "InstallBroken");
                return true;
            },
        );
    } finally {
        await close(fixture);
    }
});

test("清单自身 sha1 不符时报 InstallBroken", async () => {
    const fixture = await setup(false, true);
    try {
        await assert.rejects(
            installMojangRuntime({
                major: 21,
                root: fixture.root,
                index: fixture.index,
                options: fixture.options,
            }),
            (error: unknown) => {
                assert.equal((error as { code?: string }).code, "InstallBroken");
                return true;
            },
        );
    } finally {
        await close(fixture);
    }
});
