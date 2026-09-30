/**
 * 官方安装器：报错行的挑选
 * @author IsCibocaz
 * @since 1.6.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { usefulLines } from "../../src/version/index.ts";

test("滤掉逐个库的噪声，留下真正的错", () => {
    const lines = [
        "Considering library com.google.guava:guava:20.0@jar",
        "File /games/libraries/guava-20.0.jar exists. Checksum valid.",
        "Considering library cpw.mods:modlauncher:11.0.4@jar",
        "These libraries failed to download. Try again.",
        "com.google.guava:guava:20.0@jar",
    ];
    const text = usefulLines(lines, "/games");

    assert.match(text, /failed to download/);
    assert.doesNotMatch(text, /Considering library/);
    assert.doesNotMatch(text, /Checksum valid/);
    assert.match(text, /完整输出见 \/games\/installer\.log/);
});

test("挑不到错行时给去噪后的内容，且始终附上日志位置", () => {
    const lines = ["Considering library a@jar", "Some progress line"];
    const text = usefulLines(lines, "/games");

    assert.match(text, /Some progress line/);
    assert.doesNotMatch(text, /Considering/);
    assert.match(text, /installer\.log/);
});
