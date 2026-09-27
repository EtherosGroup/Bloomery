/**
 * Java 运行时：属性解析、架构映射、定位与选择
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { JavaSetting } from "../../src/config/types.ts";
import {
    findJava,
    javaArchOf,
    javaEntryOf,
    majorOfVersion,
    parseJavaProperties,
    probeJava,
    resolveJava,
    resolveJavaExecutable,
    resolveJavaFor,
} from "../../src/launch/java.ts";
import { JAVA_EXECUTABLE } from "../../src/platform/index.ts";

const EMPTY: JavaSetting = {
    autoDetect: true,
    autoDownload: false,
    runtimeDirectory: null,
    list: [],
};

// 本机 java -XshowSettings:properties -version 的真实形状
const SAMPLE = [
    "Property settings:",
    "    java.home = /usr/lib/jvm/jdk-21.0.12.1-oracle-x64",
    "    java.vendor = Oracle Corporation",
    "    java.version = 21.0.12.1",
    "    java.vm.name = Java HotSpot(TM) 64-Bit Server VM",
    "    os.arch = amd64",
    "",
].join("\n");

async function inTemp(run: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-java-"));
    try {
        await run(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

test("版本号到主版本", () => {
    assert.equal(majorOfVersion("21.0.12.1"), 21);
    assert.equal(majorOfVersion("25"), 25);
    assert.equal(majorOfVersion("1.8.0_402"), 8);
    assert.equal(majorOfVersion("1.7.0"), 7);
    assert.equal(majorOfVersion("9.0.1"), 9);
    assert.equal(majorOfVersion(""), null);
    assert.equal(majorOfVersion("不是版本"), null);
});

test("架构映射", () => {
    assert.equal(javaArchOf("amd64"), "x64");
    assert.equal(javaArchOf("x86_64"), "x64");
    assert.equal(javaArchOf(" AMD64 "), "x64");
    assert.equal(javaArchOf("i386"), "x86");
    assert.equal(javaArchOf("aarch64"), "arm64");
    assert.equal(javaArchOf("armv7l"), "arm");
    assert.equal(javaArchOf("riscv64"), null);
});

test("属性行解析", () => {
    const properties = parseJavaProperties(SAMPLE);
    assert.equal(properties["java.version"], "21.0.12.1");
    assert.equal(properties["java.vendor"], "Oracle Corporation");
    assert.equal(properties["os.arch"], "amd64");
    assert.equal(properties["java.home"], "/usr/lib/jvm/jdk-21.0.12.1-oracle-x64");
    // 标题行没有 "= "，不该进表
    assert.equal(Object.hasOwn(properties, "Property settings"), false);
});

test("定位可执行文件", async () => {
    await inTemp(async (root) => {
        const home = join(root, "jdk-21");
        await mkdir(join(home, "bin"), { recursive: true });
        const executable = join(home, "bin", JAVA_EXECUTABLE);
        await writeFile(executable, "");

        // 给 JAVA_HOME、给可执行文件、给不存在的路径
        assert.equal(await resolveJavaExecutable(home), executable);
        assert.equal(await resolveJavaExecutable(executable), executable);
        assert.equal(await resolveJavaExecutable(join(root, "没有这个")), undefined);
    });
});

test("清单为空时挑不出 Java", async () => {
    assert.equal(await resolveJava(EMPTY, {}), undefined);
    assert.equal(await resolveJava(EMPTY, {}, 21), undefined);
});

test("探测本机的 Java", async (t) => {
    const paths = await findJava(EMPTY);
    const first = paths[0];
    if (first === undefined) {
        t.skip("本机没有 Java");
        return;
    }

    const info = await probeJava(first, "detected");
    assert.ok(info !== null, `${first} 应该探测得出来`);
    assert.equal(info.path, first);
    assert.ok(info.major !== null && info.major > 0, `主版本应该探得出来：${info.major}`);
    assert.ok(info.arch !== null, "架构应该探得出来");
    assert.ok(info.kind === "jdk" || info.kind === "jre");
    assert.ok(Number.isFinite(Date.parse(info.probedAt)));
});

test("按主版本挑选", async (t) => {
    const paths = await findJava(EMPTY);
    const first = paths[0];
    if (first === undefined) {
        t.skip("本机没有 Java");
        return;
    }

    const info = await probeJava(first, "manual");
    assert.ok(info !== null);
    const setting: JavaSetting = { ...EMPTY, list: [javaEntryOf(info)] };

    const picked = await resolveJava(setting, {}, info.major ?? undefined);
    assert.equal(picked?.path, first);
    // 主版本对不上就挑不出来
    assert.equal(await resolveJava(setting, {}, 999), undefined);
    // 不给主版本时清单里只有它
    assert.equal((await resolveJava(setting, {}))?.path, first);
});

test("主版本对不上时退到更新的", async (t) => {
    const paths = await findJava(EMPTY);
    const first = paths[0];
    if (first === undefined) {
        t.skip("本机没有 Java");
        return;
    }

    const info = await probeJava(first, "manual");
    assert.ok(info !== null);
    assert.ok(info.major !== null);
    const setting: JavaSetting = { ...EMPTY, list: [javaEntryOf(info)] };

    // 主版本相等：不算退让
    const exact = await resolveJavaFor(setting, {}, info.major);
    assert.equal(exact?.fallback, false);
    assert.equal(exact?.info.path, first);

    // 要求更低的版本：退到手上这个
    const lower = await resolveJavaFor(setting, {}, Math.max(1, info.major - 1));
    assert.equal(lower?.fallback, true);
    assert.equal(lower?.info.path, first);

    // 要求更高的版本：没有更新的可用
    assert.equal(await resolveJavaFor(setting, {}, info.major + 1), undefined);
});
