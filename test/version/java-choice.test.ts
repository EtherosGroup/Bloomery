/**
 * 官方安装器的 java 挑选：优先要求的主版本，其次比要求大的里面最小的
 * @author IsCibocaz
 * @since 1.6.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { pickJava, requiredJavaOf } from "../../src/cli/java-choice.ts";

const JVMS = [
    { path: "/jvm/25/bin/java", major: 25 },
    { path: "/jvm/21/bin/java", major: 21 },
    { path: "/jvm/8/bin/java", major: 8 },
];

test("有正好等于要求的就用它", () => {
    assert.equal(pickJava(JVMS, 21), "/jvm/21/bin/java");
    assert.equal(pickJava(JVMS, 8), "/jvm/8/bin/java");
});

test("没有正好的那就取比要求大的里面最小的", () => {
    // 要求 17 时该给 21，不是 25：Forge 1.20.6 的安装器在 25 上会卡死
    assert.equal(pickJava(JVMS, 17), "/jvm/21/bin/java");
    assert.equal(pickJava(JVMS, 9), "/jvm/21/bin/java");
});

test("都比要求小时取最大的", () => {
    assert.equal(pickJava(JVMS, 30), "/jvm/25/bin/java");
});

test("拿不到要求时按 17 起步，主版本未知的兜底", () => {
    assert.equal(pickJava(JVMS, null), "/jvm/21/bin/java");
    assert.equal(pickJava([{ path: "/jvm/x/bin/java", major: null }], null), "/jvm/x/bin/java");
    assert.equal(pickJava([], null), undefined);
});

test("从版本 json 取 Java 主版本要求", () => {
    assert.equal(requiredJavaOf({ javaVersion: { majorVersion: 8 } }), 8);
    assert.equal(requiredJavaOf({ javaVersion: { majorVersion: 21 } }), 21);
    assert.equal(requiredJavaOf({ javaVersion: {} }), null);
    assert.equal(requiredJavaOf({}), null);
    assert.equal(requiredJavaOf(null), null);
    assert.equal(requiredJavaOf({ javaVersion: { majorVersion: "8" } }), null);
});

test("要求 8 时挑 8，缺 8 才退到比 8 大的里面最小的", () => {
    assert.equal(pickJava(JVMS, 8), "/jvm/8/bin/java");

    const noEight = JVMS.filter((item) => item.major !== 8);
    assert.equal(pickJava(noEight, 8), "/jvm/21/bin/java");
    assert.equal(pickJava(noEight, 25), "/jvm/25/bin/java");
});
