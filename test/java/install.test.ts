/**
 * 包内顶层目录的推导
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { commonTop } from "../../src/java/install.ts";

test("所有条目同一个顶层目录时推得出来", () => {
    // 目录条目在 tar 里带尾斜杠，读取时被去掉，仍要算作顶层
    assert.equal(
        commonTop([
            "jdk-21.0.12.1+1-jre",
            "jdk-21.0.12.1+1-jre/bin/java",
            "jdk-21.0.12.1+1-jre/release",
        ]),
        "jdk-21.0.12.1+1-jre",
    );
});

test("顶层不统一时按原样解", () => {
    assert.equal(commonTop(["bin/java", "lib/lib.so", "legal/x"]), "");
    assert.equal(commonTop(["a/bin/java", "b/bin/java"]), "");
    assert.equal(commonTop([]), "");
    assert.equal(commonTop(["jdk-21/bin/java"]), "jdk-21");
});
