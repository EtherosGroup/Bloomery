/**
 * 启动游戏用的可执行文件：Windows 上把 java.exe 换成同目录的 javaw.exe
 * @author IsCibocaz
 * @since 1.12.5
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { javawPath } from "../../src/platform/java.ts";

test("Windows 的 java.exe 换成同目录的 javaw.exe", () => {
    assert.equal(javawPath("C:\\jdk-21\\bin\\java.exe"), "C:\\jdk-21\\bin\\javaw.exe");
    // 只换后缀，不动分隔符：路径可能来自别的平台写法
    assert.equal(javawPath("/opt/jdk/bin/java.exe"), "/opt/jdk/bin/javaw.exe");
});

test("已经是 javaw.exe 或非 Windows 的 java 给 null", () => {
    assert.equal(javawPath("C:\\jdk\\bin\\javaw.exe"), null);
    assert.equal(javawPath("/usr/lib/jvm/21/bin/java"), null);
    assert.equal(javawPath(""), null);
});

test("后缀大小写不敏感", () => {
    assert.equal(javawPath("C:\\JDK\\BIN\\JAVA.EXE"), "C:\\JDK\\BIN\\javaw.exe");
});
