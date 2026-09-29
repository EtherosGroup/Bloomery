/**
 * 输出层：控制台经流转码的判定
 * @author IsCibocaz
 * @since 1.1.1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { throughStream } from "../../src/output/output.ts";

test("Windows 控制台交给流，管道与其余平台直写", () => {
    // Windows 控制台按代码页解释字节，直写 UTF-8 会乱码
    assert.equal(throughStream("win32", true), true);
    // 管道与文件不是控制台，直写才对，也保住了 EPIPE 与 EAGAIN 的处理
    assert.equal(throughStream("win32", false), false);
    assert.equal(throughStream("linux", true), false);
    assert.equal(throughStream("darwin", true), false);
});
