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

import { classifierMatches, libraryFile, parseCoordinate } from "../../src/dependency/library.ts";
import { nativeClassifierOf, nativeJars } from "../../src/dependency/native.ts";
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
