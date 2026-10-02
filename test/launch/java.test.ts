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

import type { JavaSetting, JavaSource } from "../../src/config/types.ts";
import {
    chooseJava,
    findJava,
    javaArchOf,
    javaEntryOf,
    majorOfVersion,
    parseJavaProperties,
    probeJava,
    resolveJava,
    resolveJavaExecutable,
    resolveJavaFor,
    resolveJavaPick,
    type JavaInfo,
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

// 探好的候选进选取规则，详情与启动共用这一条
function jvm(path: string, major: number | null, source: JavaSource = "detected"): JavaInfo {
    return {
        path,
        major,
        arch: "x64",
        vendor: null,
        kind: "jdk",
        home: null,
        source,
        probedAt: "2026-10-02T00:00:00.000Z",
    };
}

test("主版本正好相等就选它", () => {
    const candidates = [
        jvm("/jvm/25/bin/java", 25),
        jvm("/jvm/21/bin/java", 21),
        jvm("/jvm/8/bin/java", 8),
    ];
    const choice = chooseJava(candidates, 21);
    assert.equal(choice?.info.path, "/jvm/21/bin/java");
    assert.equal(choice?.fallback, false);
});

test("没有相等的就取比要求大的里面最小的", () => {
    const candidates = [
        jvm("/jvm/25/bin/java", 25),
        jvm("/jvm/21/bin/java", 21),
        jvm("/jvm/8/bin/java", 8),
    ];
    const choice = chooseJava(candidates, 17);
    assert.equal(choice?.info.path, "/jvm/21/bin/java");
    assert.equal(choice?.fallback, true);
});

test("只有比要求旧的候选时挑不出来", () => {
    // 启动会报 JavaNotFound，详情也不能报一个启动会拒绝的 Java
    const onlyOlder = [jvm("/jvm/8/bin/java", 8), jvm("/jvm/11/bin/java", 11)];
    assert.equal(chooseJava(onlyOlder, 25), undefined);
    assert.equal(chooseJava(onlyOlder, 17), undefined);
});

test("候选为空时挑不出来", () => {
    assert.equal(chooseJava([], 25), undefined);
    assert.equal(chooseJava([], undefined), undefined);
});

test("指定路径优先于清单", async (t) => {
    const paths = await findJava(EMPTY);
    const first = paths[0];
    if (first === undefined) {
        t.skip("本机没有 Java");
        return;
    }

    // 清单是空的也照样用指定路径：覆盖不经过清单
    const pick = await resolveJavaPick(EMPTY, {}, first, 21);
    assert.ok(pick.kind === "manual", `应该走指定路径：${pick.kind}`);
    assert.equal(pick.info.path, first);
    assert.equal(pick.info.source, "manual");
});

test("指定路径不存在时给 manualMissing", async () => {
    await inTemp(async (root) => {
        const missing = join(root, "没有这个", JAVA_EXECUTABLE);
        const pick = await resolveJavaPick(EMPTY, {}, missing, 21);
        assert.ok(pick.kind === "manualMissing", `应该报路径不存在：${pick.kind}`);
        assert.equal(pick.detail, missing);
    });
});

test("指定路径跑不起来时给 manualBroken", async () => {
    await inTemp(async (root) => {
        const broken = join(root, JAVA_EXECUTABLE);
        await writeFile(broken, "");
        const pick = await resolveJavaPick(EMPTY, {}, broken, 21);
        assert.ok(pick.kind === "manualBroken", `应该报跑不起来：${pick.kind}`);
        assert.equal(pick.detail, broken);
    });
});

test("没有指定路径时按清单挑", async (t) => {
    const paths = await findJava(EMPTY);
    const first = paths[0];
    if (first === undefined) {
        t.skip("本机没有 Java");
        return;
    }

    const info = await probeJava(first, "manual");
    assert.ok(info !== null);
    const setting: JavaSetting = { ...EMPTY, list: [javaEntryOf(info)] };

    const exact = await resolveJavaPick(setting, {}, null, info.major ?? undefined);
    assert.ok(exact.kind === "auto", `应该走清单：${exact.kind}`);
    assert.equal(exact.fallback, false);
    assert.equal(exact.info.path, first);

    // 主版本对不上就退到更新的，退让标记带出来
    const lower = await resolveJavaPick(setting, {}, null, Math.max(1, (info.major ?? 1) - 1));
    assert.ok(lower.kind === "auto");
    assert.equal(lower.fallback, true);
});

test("没有指定路径且清单为空时给 autoMissing", async () => {
    const pick = await resolveJavaPick(EMPTY, {}, null, 21);
    assert.equal(pick.kind, "autoMissing");
});
