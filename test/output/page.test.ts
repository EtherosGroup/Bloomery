/**
 * 分页：切片与页码收敛
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { paginate } from "../../src/output/index.ts";

const ITEMS = Array.from({ length: 45 }, (_, index) => index + 1);

test("按每页 20 条切分", () => {
    const first = paginate(ITEMS, 1, 20);
    assert.equal(first.page, 1);
    assert.equal(first.pages, 3);
    assert.equal(first.total, 45);
    assert.equal(first.items.length, 20);
    assert.equal(first.items[0], 1);

    const middle = paginate(ITEMS, 2, 20);
    assert.equal(middle.items[0], 21);

    const last = paginate(ITEMS, 3, 20);
    assert.deepEqual(last.items, [41, 42, 43, 44, 45]);
});

test("页码越界贴到边界", () => {
    assert.equal(paginate(ITEMS, 99, 20).page, 3);
    assert.equal(paginate(ITEMS, 0, 20).page, 1);
    assert.equal(paginate(ITEMS, -5, 20).page, 1);
});

test("空清单也有一页", () => {
    const page = paginate([], 3, 20);
    assert.equal(page.pages, 1);
    assert.equal(page.page, 1);
    assert.deepEqual(page.items, []);
});
