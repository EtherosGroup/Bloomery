/**
 * 启动文件缺失检测：客户端 jar、库、natives、资源
 * @author IsCibocaz
 * @since 1.10.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { platformContext } from "../../src/dependency/index.ts";
import { parseDescriptor, type Descriptor } from "../../src/version/descriptor.ts";
import {
    clientJarOf,
    firstMissing,
    missingLaunchFiles,
    type InstanceFiles,
} from "../../src/version/files.ts";

// 按当前平台拼 natives 分类名，测试在哪个平台跑都用得上
const CLASSIFIER = ((): string => {
    const context = platformContext();
    const os = context.osName === "osx" ? "macos" : context.osName;
    return `natives-${os}${context.osArch === "arm64" ? "-arm64" : ""}`;
})();

const LIBRARY = "a.b:c:1.0";
const NATIVE = `d.e:f:1.0:${CLASSIFIER}`;
const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

function versionJson(assetIndex: Record<string, unknown> = { id: "32", url: null }): unknown {
    return {
        id: "t",
        type: "release",
        mainClass: "com.example.Main",
        assets: "32",
        assetIndex,
        downloads: {
            client: { sha1: "", size: 0, url: "https://example.com/client.jar" },
        },
        libraries: [
            {
                name: LIBRARY,
                downloads: {
                    artifact: { sha1: "", size: 0, url: "https://example.com/c-1.0.jar" },
                },
            },
            {
                name: NATIVE,
                downloads: {
                    artifact: { sha1: "", size: 0, url: "https://example.com/f-1.0.jar" },
                },
            },
        ],
    };
}

function libraryPath(root: string, coordinate: string): string {
    const [group = "", artifact = "", version = "", classifier] = coordinate.split(":");
    const file =
        classifier === undefined
            ? `${artifact}-${version}.jar`
            : `${artifact}-${version}-${classifier}.jar`;
    return join(root, "libraries", group.replace(/\./g, "/"), artifact, version, file);
}

function objectPath(root: string, hash: string): string {
    return join(root, "assets", "objects", hash.slice(0, 2), hash);
}

async function write(path: string, text: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
}

async function writeIndex(root: string, hashes: readonly string[]): Promise<void> {
    const objects: Record<string, { hash: string; size: number }> = {};
    hashes.forEach((hash, index) => {
        objects[`minecraft/${index}.txt`] = { hash, size: 3 };
    });
    await write(join(root, "assets", "indexes", "32.json"), JSON.stringify({ id: "32", objects }));
}

interface Fixture {
    readonly root: string;
    readonly directory: string;
    readonly descriptor: Descriptor;
    readonly instance: InstanceFiles;
}

// 齐的实例：客户端 jar、一个库、一个 natives jar 都在
async function setup(
    assetIndex: Record<string, unknown> = { id: "32", url: null },
): Promise<Fixture> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-files-"));
    const directory = join(root, "versions", "t");
    await mkdir(directory, { recursive: true });
    const jsonPath = join(directory, "t.json");
    await writeFile(jsonPath, JSON.stringify(versionJson(assetIndex)));

    const descriptor = parseDescriptor(versionJson(assetIndex), jsonPath, "t", jsonPath);
    assert.ok(descriptor !== undefined);
    const instance: InstanceFiles = {
        id: "t",
        target: "t",
        chain: ["t"],
        directory,
        descriptor,
        problem: null,
    };

    await write(join(directory, "t.jar"), "client");
    await write(libraryPath(root, LIBRARY), "library");
    await write(libraryPath(root, NATIVE), "natives");

    return { root, directory, descriptor, instance };
}

async function close(fixture: Fixture): Promise<void> {
    await rm(fixture.root, { recursive: true, force: true });
}

test("完整实例没有缺件", async () => {
    const fixture = await setup();
    try {
        const missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });

        assert.equal(missing.total, 0);
        assert.equal(missing.clientJar, null);
        assert.deepEqual(missing.libraries, []);
        assert.deepEqual(missing.natives, []);
        assert.equal(missing.assets, null);
        assert.equal(firstMissing(missing), null);
    } finally {
        await close(fixture);
    }
});

test("缺客户端 jar、库、natives 都算缺件", async () => {
    const fixture = await setup();
    try {
        const clientJar = join(fixture.directory, "t.jar");
        await rm(libraryPath(fixture.root, LIBRARY));
        await rm(libraryPath(fixture.root, NATIVE));
        await rm(clientJar);

        const missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });

        assert.equal(missing.clientJar, clientJar);
        assert.equal(missing.libraries.length, 1);
        assert.equal(missing.libraries[0], libraryPath(fixture.root, LIBRARY));
        assert.equal(missing.natives.length, 1);
        assert.equal(missing.natives[0], libraryPath(fixture.root, NATIVE));
        assert.equal(missing.total, 3);
        assert.equal(missing.files.length, 3);
        assert.match(firstMissing(missing) ?? "", /^客户端 jar /);
    } finally {
        await close(fixture);
    }
});

test("版本 json 没给索引地址时不报资源缺件", async () => {
    const fixture = await setup();
    try {
        const missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });
        // 补不了的那类不报，报出来只会拦住启动
        assert.equal(missing.assets, null);
        assert.equal(missing.total, 0);
    } finally {
        await close(fixture);
    }
});

test("索引整份不在时按版本 json 报待下载大小", async () => {
    const fixture = await setup({
        id: "32",
        url: "https://example.com/32.json",
        size: 1000,
        totalSize: 4000,
    });
    try {
        const missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });

        // 条数要等索引取回，大小是 totalSize 加索引自身
        assert.deepEqual(missing.assets, {
            index: "32",
            total: null,
            present: 0,
            missing: null,
            size: 5000,
        });
        // 总数只算索引本身一项
        assert.equal(missing.total, 1);
        assert.equal(firstMissing(missing), "资源索引 32");
    } finally {
        await close(fixture);
    }
});

test("索引文件在但读不出来时不报资源缺件", async () => {
    const fixture = await setup({
        id: "32",
        url: "https://example.com/32.json",
        size: 1000,
        totalSize: 4000,
    });
    try {
        // 文件在时补不动（下载会跳过已存在的落点），报成缺件只会拦住启动
        await write(join(fixture.root, "assets", "indexes", "32.json"), "不是 json");

        const missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });
        assert.equal(missing.assets, null);
        assert.equal(missing.total, 0);
    } finally {
        await close(fixture);
    }
});

test("索引在本地时把缺的资源对象算进缺件", async () => {
    const fixture = await setup();
    try {
        await writeIndex(fixture.root, [HASH_A]);
        await write(objectPath(fixture.root, HASH_A), "aaa");

        let missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });
        assert.deepEqual(missing.assets, {
            index: "32",
            total: 1,
            present: 1,
            missing: 0,
            size: 0,
        });
        assert.equal(missing.total, 0);

        await writeIndex(fixture.root, [HASH_A, HASH_B]);
        missing = await missingLaunchFiles({
            folderPath: fixture.root,
            instance: fixture.instance,
        });
        // 缺的那个 size 是 3
        assert.deepEqual(missing.assets, {
            index: "32",
            total: 2,
            present: 1,
            missing: 1,
            size: 3,
        });
        assert.equal(missing.total, 1);
        assert.equal(firstMissing(missing), "1 个资源对象");
    } finally {
        await close(fixture);
    }
});

test("版本读不出来时报 VersionBroken", async () => {
    await assert.rejects(
        missingLaunchFiles({
            folderPath: "/nowhere",
            instance: {
                id: "t",
                target: "t",
                chain: [],
                directory: "/nowhere/versions/t",
                descriptor: null,
                problem: "版本 json 读不出来",
            },
        }),
        (error: unknown) => (error as { code?: string }).code === "VersionBroken",
    );
});

test("客户端 jar 的落点：继承型用基础版本那份", () => {
    const where = "/v/child.json";
    const plain = parseDescriptor(
        { id: "child", inheritsFrom: "1.20.6", mainClass: "x.Y", libraries: [] },
        where,
        "child",
        where,
    );
    assert.ok(plain !== undefined);
    assert.equal(
        clientJarOf("/game", plain, { id: "child", target: "1.20.6", chain: ["child", "1.20.6"] }),
        join("/game", "versions", "1.20.6", "1.20.6.jar"),
    );
    // 链只有自己一层就用自己目录里的那份
    assert.equal(
        clientJarOf("/game", plain, { id: "child", target: "1.20.6", chain: ["child"] }),
        join("/game", "versions", "child", "child.jar"),
    );

    const jarred = parseDescriptor(
        { id: "x", jar: "base", mainClass: "x.Y", libraries: [] },
        where,
        "x",
        where,
    );
    assert.ok(jarred !== undefined);
    // json 里点名了 jar 就听它的
    assert.equal(
        clientJarOf("/game", jarred, { id: "x", target: "x", chain: ["x"] }),
        join("/game", "versions", "base", "base.jar"),
    );
});
