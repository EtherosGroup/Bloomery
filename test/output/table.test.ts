/**
 * 表格：列宽、CJK 对齐、右对齐、缩进与尾空格
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderTable } from "../../src/output/table.ts";
import { displayWidth } from "../../src/output/text.ts";

test("列宽按最宽的单元格取", () => {
    assert.deepEqual(
        renderTable([
            ["a", "b", "c"],
            ["longer", "x", "y"],
        ]),
        ["a       b  c", "longer  x  y"],
    );
});

test("CJK 按两格算", () => {
    const lines = renderTable([
        ["中文", "a"],
        ["ab", "b"],
    ]);
    assert.deepEqual(lines, ["中文  a", "ab    b"]);
    // 两行的显示宽度一致，字面上长度不同
    assert.equal(displayWidth(lines[0] ?? ""), displayWidth(lines[1] ?? ""));
    assert.notEqual((lines[0] ?? "").length, (lines[1] ?? "").length);
});

test("右对齐的列", () => {
    assert.deepEqual(
        renderTable(
            [
                ["a", "1", "x"],
                ["b", "100", "y"],
            ],
            { right: [1] },
        ),
        ["a    1  x", "b  100  y"],
    );
});

test("末列空着时不留尾空格", () => {
    assert.deepEqual(
        renderTable([
            ["a", "b", ""],
            ["ccc", "d", ""],
        ]),
        ["a    b", "ccc  d"],
    );
});

test("缩进与列间距", () => {
    assert.deepEqual(renderTable([["a", "b"]], { indent: "  ", gap: 4 }), ["  a    b"]);
});

test("空表没有行", () => {
    assert.deepEqual(renderTable([]), []);
});
