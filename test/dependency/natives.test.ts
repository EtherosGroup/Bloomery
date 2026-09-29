/**
 * 依赖层：natives 变体的平台与架构筛选
 * @author IsCibocaz
 * @since 1.1.4
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { classpathOf } from "../../src/dependency/classpath.ts";
import { classifierMatches, libraryFile, parseCoordinate } from "../../src/dependency/library.ts";
import { nativeClassifierOf, nativeJars, nativesLayout } from "../../src/dependency/native.ts";
import type { RuleContext } from "../../src/dependency/rules.ts";
import { parseDescriptor } from "../../src/version/descriptor.ts";

function context(osName: string, osArch: RuleContext["osArch"]): RuleContext {
    return { osName, osVersion: "", osArch, features: {} };
}

const WINDOWS_X64 = context("windows", "x64");

test("natives 分类名按平台与架构筛", () => {
    const cases: ReadonlyArray<[string, RuleContext, boolean]> = [
        // json 里 natives-windows 与 -arm64/-x86 的 rules 完全一样，只能靠分类名区分
        ["natives-windows", WINDOWS_X64, true],
        ["natives-windows-arm64", WINDOWS_X64, false],
        ["natives-windows-x86", WINDOWS_X64, false],
        ["natives-windows-x86", context("windows", "x86"), true],
        ["natives-windows", context("windows", "arm64"), false],
        ["natives-windows-arm64", context("windows", "arm64"), true],
        ["natives-linux", context("linux", "x64"), true],
        ["natives-linux", context("linux", "arm64"), false],
        ["natives-linux-arm64", context("linux", "x64"), false],
        ["natives-linux-arm64", context("linux", "arm64"), true],
        // 第二段不是架构：按不带架构段处理，Intel 用的补丁版不该上 arm64
        ["natives-macos-patch", context("osx", "x64"), true],
        ["natives-macos-patch", context("osx", "arm64"), false],
        ["natives-macos-arm64", context("osx", "arm64"), true],
        // 平台对不上直接否
        ["natives-linux", WINDOWS_X64, false],
        // netty 那类分类名的行为不变
        ["linux-x86_64", context("linux", "x64"), true],
        ["linux-aarch_64", context("linux", "x64"), false],
        ["linux-riscv64", context("linux", "x64"), false],
        ["osx-aarch_64", context("osx", "arm64"), true],
    ];

    for (const [classifier, ctx, want] of cases) {
        assert.equal(
            classifierMatches(classifier, ctx),
            want,
            `${classifier} 在 ${ctx.osName}-${ctx.osArch}`,
        );
    }
});

test("旧写法的 natives 映射会填 ${arch}", () => {
    const descriptor = parseDescriptor(
        {
            id: "t",
            libraries: [
                { name: "org.lwjgl:lwjgl:3.3.3", natives: { windows: "natives-windows-${arch}" } },
            ],
        },
        "test",
        "t",
        "/tmp/t/t.json",
    );
    assert.ok(descriptor !== undefined);
    const library = descriptor.libraries[0];
    assert.ok(library !== undefined);

    assert.equal(nativeClassifierOf(library, WINDOWS_X64), "natives-windows-64");
    assert.equal(nativeClassifierOf(library, context("windows", "x86")), "natives-windows-32");
    // 平台对不上就不给
    assert.equal(nativeClassifierOf(library, context("linux", "x64")), undefined);
});

test("三个 Windows 变体都在时只选当前架构那份", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-natives-"));
    try {
        const names = [
            "org.lwjgl:lwjgl:3.3.3:natives-windows",
            "org.lwjgl:lwjgl:3.3.3:natives-windows-arm64",
            "org.lwjgl:lwjgl:3.3.3:natives-windows-x86",
        ];
        for (const name of names) {
            const coordinate = parseCoordinate(name);
            assert.ok(coordinate !== undefined);
            const file = libraryFile(root, coordinate);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, "");
        }

        const descriptor = parseDescriptor(
            { id: "t", libraries: names.map((name) => ({ name })) },
            "test",
            "t",
            join(root, "t.json"),
        );
        assert.ok(descriptor !== undefined);

        const selection = await nativeJars({
            libraries: descriptor.libraries,
            context: WINDOWS_X64,
            librariesRoot: root,
        });
        assert.deepEqual(
            selection.jars.map((jar) => jar.classifier),
            ["natives-windows"],
        );
        assert.deepEqual(selection.missing, []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("natives 布局：老写法平铺，26.x 分目录", () => {
    const directory = join("/games", "versions", "t", "natives");

    // 1.20.6：四个属性都指向 natives 目录本身，dll 平铺一层
    const old = nativesLayout(
        [
            "-Djava.library.path=${natives_directory}",
            "-Djna.tmpdir=${natives_directory}",
            "-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}",
            "-Dio.netty.native.workdir=${natives_directory}",
            "-cp",
            "${classpath}",
        ],
        directory,
    );
    assert.equal(old.libraryPath, directory);
    assert.deepEqual(old.extraDirectories, []);
    assert.equal(old.classpath, false);

    // 26.2：dll 要解到 java/，另三个目录给 JNA、LWJGL、netty 当解压目标，jar 还要进 classpath
    const fresh = nativesLayout(
        [
            "--enable-native-access=ALL-UNNAMED",
            "-Djava.library.path=${natives_directory}/java",
            "-Djna.tmpdir=${natives_directory}/jna",
            "-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}/lwjgl",
            "-Dio.netty.native.workdir=${natives_directory}/netty",
            "-cp",
            "${classpath}",
        ],
        directory,
    );
    assert.equal(fresh.libraryPath, join(directory, "java"));
    assert.deepEqual(fresh.extraDirectories, [
        join(directory, "jna"),
        join(directory, "lwjgl"),
        join(directory, "netty"),
    ]);
    assert.equal(fresh.classpath, true);
});

test("natives 布局：指向 natives 目录之外就按老布局来", () => {
    const directory = join("/games", "versions", "t", "natives");

    // 属性缺失不算新版布局
    const missing = nativesLayout(["-cp", "${classpath}"], directory);
    assert.equal(missing.libraryPath, directory);
    assert.equal(missing.classpath, false);

    // 指到别处也不能把 dll 解到那里去
    const outside = nativesLayout(["-Djava.library.path=/usr/lib/jni"], directory);
    assert.equal(outside.libraryPath, directory);
    assert.equal(outside.classpath, false);
});

test("natives jar 排在客户端 jar 前面", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-classpath-"));
    try {
        const natives = join(root, "natives.jar");
        const client = join(root, "client.jar");
        await writeFile(natives, "");
        await writeFile(client, "");

        const result = await classpathOf({
            libraries: [],
            context: WINDOWS_X64,
            librariesRoot: root,
            clientJar: client,
            natives: [natives, join(root, "missing.jar")],
        });
        assert.deepEqual(result.entries, [natives, client]);
        assert.deepEqual(result.missing, [join(root, "missing.jar")]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
