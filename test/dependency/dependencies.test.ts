/**
 * 依赖层：rules 过滤、库坐标、classpath
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { classpathOf } from "../../src/dependency/classpath.ts";
import {
    classifierMatches,
    isClasspathLibrary,
    libraryPath,
    parseCoordinate,
} from "../../src/dependency/library.ts";
import { allows, type RuleContext } from "../../src/dependency/rules.ts";
import { parseDescriptor, type Library } from "../../src/version/descriptor.ts";

const LINUX_X64: RuleContext = {
    osName: "linux",
    osVersion: "6.8.0-45-generic",
    osArch: "x64",
    features: {},
};

function libraries(json: unknown): Library[] {
    const descriptor = parseDescriptor({ id: "t", libraries: json }, "test", "t", "/tmp/t/t.json");
    assert.ok(descriptor !== undefined);
    return [...descriptor.libraries];
}

test("没有 rules 视为通过", () => {
    assert.equal(allows(null, LINUX_X64), true);
    assert.equal(allows([], LINUX_X64), true);
});

test("allow 与 disallow 按顺序覆盖", () => {
    assert.equal(allows([{ action: "allow", os: null, features: null }], LINUX_X64), true);
    assert.equal(
        allows(
            [
                {
                    action: "allow",
                    os: { name: "windows", version: null, arch: null },
                    features: null,
                },
            ],
            LINUX_X64,
        ),
        false,
    );
    // 先允许再禁止，最后的动作说了算
    assert.equal(
        allows(
            [
                { action: "allow", os: null, features: null },
                {
                    action: "disallow",
                    os: { name: "linux", version: null, arch: null },
                    features: null,
                },
            ],
            LINUX_X64,
        ),
        false,
    );
    // 先禁止再允许
    assert.equal(
        allows(
            [
                {
                    action: "disallow",
                    os: { name: "linux", version: null, arch: null },
                    features: null,
                },
                { action: "allow", os: null, features: null },
            ],
            LINUX_X64,
        ),
        true,
    );
});

test("架构别名", () => {
    const rule = (arch: string) =>
        allows(
            [{ action: "allow", os: { name: null, version: null, arch }, features: null }],
            LINUX_X64,
        );
    assert.equal(rule("x86_64"), true);
    assert.equal(rule("amd64"), true);
    assert.equal(rule("aarch_64"), false);
    assert.equal(rule("aarch64"), false);
    // 没有架构信息的规则不看架构
    assert.equal(
        allows(
            [{ action: "allow", os: { name: null, version: null, arch: null }, features: null }],
            LINUX_X64,
        ),
        true,
    );
});

test("os.version 是正则", () => {
    const rule = (version: string) =>
        allows(
            [{ action: "allow", os: { name: null, version, arch: null }, features: null }],
            LINUX_X64,
        );
    assert.equal(rule("^6\\."), true);
    assert.equal(rule("^10\\."), false);
    assert.equal(rule("(("), false);
});

test("features 要逐个相等", () => {
    const demo: RuleContext = { ...LINUX_X64, features: { is_demo_user: true } };
    const rule = { action: "allow" as const, os: null, features: { is_demo_user: true } };
    assert.equal(allows([rule], demo), true);
    assert.equal(allows([rule], LINUX_X64), false);
});

test("库坐标与路径", () => {
    assert.deepEqual(parseCoordinate("a.b:c:1.0"), {
        group: "a.b",
        artifact: "c",
        version: "1.0",
        classifier: null,
        extension: "jar",
    });
    assert.deepEqual(parseCoordinate("a.b:c:1.0:natives-linux"), {
        group: "a.b",
        artifact: "c",
        version: "1.0",
        classifier: "natives-linux",
        extension: "jar",
    });
    assert.equal(parseCoordinate("缺版本:c"), undefined);

    const [plain, classified] = [
        parseCoordinate("a.b:c:1.0"),
        parseCoordinate("a.b:c:1.0:natives-linux"),
    ];
    assert.ok(plain !== undefined && classified !== undefined);
    assert.equal(libraryPath(plain), join("a", "b", "c", "1.0", "c-1.0.jar"));
    assert.equal(libraryPath(classified), join("a", "b", "c", "1.0", "c-1.0-natives-linux.jar"));
});

test("哪些库进 classpath", () => {
    const [plain, native, classifier] = libraries([
        { name: "a.b:c:1.0", downloads: { artifact: { sha1: "x", size: 1, url: "u" } } },
        {
            name: "a.b:c:1.0:natives-linux",
            downloads: { classifiers: { "natives-linux": { sha1: "y", size: 1, url: "u" } } },
        },
        {
            name: "a.b:c:1.0:linux-x86_64",
            downloads: { artifact: { sha1: "z", size: 1, url: "u" } },
        },
    ]);
    assert.ok(plain !== undefined && native !== undefined && classifier !== undefined);
    assert.equal(isClasspathLibrary(plain), true);
    assert.equal(isClasspathLibrary(native), false);
    assert.equal(isClasspathLibrary(classifier), true);
});

test("按分类名筛平台", () => {
    assert.equal(classifierMatches("linux-x86_64", LINUX_X64), true);
    assert.equal(classifierMatches("linux-aarch_64", LINUX_X64), false);
    assert.equal(classifierMatches("windows-x86_64", LINUX_X64), false);
    assert.equal(classifierMatches("osx-aarch_64", LINUX_X64), false);
    // 不是平台分类名的不参与判断
    assert.equal(classifierMatches("sources", LINUX_X64), true);
    assert.equal(classifierMatches("natives-linux", LINUX_X64), true);
});

test("classpath 拼装", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-cp-"));
    try {
        const libs = libraries([
            { name: "a.b:c:1.0", downloads: { artifact: { sha1: "x", size: 1, url: "u" } } },
            { name: "d.e:f:2.0", downloads: { artifact: { sha1: "y", size: 1, url: "u" } } },
            {
                name: "g.h:i:3.0:natives-linux",
                downloads: { classifiers: { "natives-linux": { sha1: "z", size: 1, url: "u" } } },
            },
            {
                name: "j.k:l:4.0:linux-aarch_64",
                downloads: { artifact: { sha1: "w", size: 1, url: "u" } },
            },
        ]);
        assert.ok(libs !== undefined);

        const clientJar = join(root, "client.jar");
        await writeFile(clientJar, "jar");

        const present = join(root, "a", "b", "c", "1.0", "c-1.0.jar");
        await mkdir(join(root, "a", "b", "c", "1.0"), { recursive: true });
        await writeFile(present, "jar");

        const classpath = await classpathOf({
            libraries: libs,
            context: LINUX_X64,
            librariesRoot: root,
            clientJar,
        });

        // natives 与不匹配当前架构的分类名都不进，客户端 jar 在最后
        assert.deepEqual(classpath.entries, [present, clientJar]);
        assert.deepEqual(classpath.missing, [join(root, "d", "e", "f", "2.0", "f-2.0.jar")]);
        assert.equal(classpath.clientJarPresent, true);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("客户端 jar 不在时单独报出来", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-cp-"));
    try {
        const classpath = await classpathOf({
            libraries: [],
            context: LINUX_X64,
            librariesRoot: root,
            clientJar: join(root, "client.jar"),
        });
        assert.deepEqual(classpath.entries, []);
        assert.equal(classpath.clientJarPresent, false);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
