/**
 * 进度条：条的渲染、换阶段、节流、非交互与关掉
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    displayWidth,
    progressReporter,
    renderBar,
    type ProgressIo,
} from "../../src/output/progress.ts";

interface Fake extends ProgressIo {
    readonly writes: string[];
    readonly lines: string[];
}

function fakeIo(overrides: Partial<ProgressIo> = {}): Fake {
    const writes: string[] = [];
    const lines: string[] = [];
    return {
        interactive: true,
        width: 40,
        write: (text) => writes.push(text),
        line: (text) => lines.push(text),
        writes,
        lines,
        ...overrides,
    };
}

test("条的宽度与填充", () => {
    // 中文标签占两格，整行按显示宽度对齐
    assert.equal(displayWidth("资源"), 4);
    assert.equal(displayWidth("natives"), 7);

    const half = renderBar("资源", 50, 100, 40);
    assert.equal(displayWidth(half), 40);
    assert.match(half, /^\[#{14} {14}\]  50% 资源$/);

    // 百分比位数变化时条不伸缩，括号里始终一样宽
    const empty = renderBar("库", 0, 10, 40);
    const full = renderBar("库", 10, 10, 40);
    assert.equal(displayWidth(empty), 40);
    assert.equal(displayWidth(full), 40);
    assert.match(empty, /^\[ {30}\]   0% 库$/);
    assert.match(full, /^\[#{30}\] 100% 库$/);
});

test("总数未知时按满算", () => {
    assert.match(renderBar("库", 0, 0, 40), /100%/);
});

test("换阶段时上一行留在屏幕上", () => {
    const io = fakeIo();
    const bar = progressReporter("bar", io);

    bar.update("库", 0, 2);
    bar.update("库", 2, 2);
    bar.update("natives", 0, 1);
    bar.close();

    // 换阶段前后各补一个换行：库 那行收尾，natives 那行收尾
    assert.equal(io.writes.filter((text) => text === "\n").length, 2);
    assert.equal(io.writes.filter((text) => text.startsWith("\r[")).length, 3);
    assert.match(io.writes.at(-2) ?? "", /0% natives$/);
    assert.equal(io.writes.at(-1), "\n");
});

test("同一个百分比不重复刷", () => {
    const io = fakeIo();
    const bar = progressReporter("bar", io);

    // 40 格的条里，1/1000 与 9/1000 都是 0%，只该刷一次
    bar.update("资源", 1, 1000);
    bar.update("资源", 9, 1000);
    assert.equal(io.writes.length, 1);

    // 最后一步无论百分比是否相同都要刷
    bar.update("资源", 1000, 1000);
    assert.equal(io.writes.length, 2);
    assert.match(io.writes.at(-1) ?? "", /100%/);
});

test("非交互退化成按阶段报数", () => {
    const io = fakeIo({ interactive: false });
    const bar = progressReporter("bar", io);

    bar.update("库", 0, 3);
    bar.update("库", 1, 3);
    bar.update("库", 3, 3);
    bar.close();

    assert.deepEqual(io.writes, []);
    assert.deepEqual(io.lines, ["库 0/3", "库 3/3"]);
});

test("按字节报时用人看的单位", () => {
    const io = fakeIo({ interactive: false });
    const bar = progressReporter("bar", io);
    const total = 100 * 1024 * 1024;

    bar.update("客户端 jar", 0, total, true);
    bar.update("客户端 jar", total * 0.51, total, true);
    bar.update("客户端 jar", total, total, true);

    // 每 5% 一行，0 与收尾必报
    assert.deepEqual(io.lines, [
        "客户端 jar 0KB/100.0MB",
        "客户端 jar 51.0MB/100.0MB",
        "客户端 jar 100.0MB/100.0MB",
    ]);
});

test("plain 直接用报数", () => {
    const io = fakeIo({ interactive: true });
    const bar = progressReporter("plain", io);

    bar.update("库", 3, 3);
    assert.deepEqual(io.writes, []);
    assert.deepEqual(io.lines, ["库 3/3"]);
});

test("off 什么都不输出", () => {
    const io = fakeIo();
    const bar = progressReporter("off", io);

    bar.update("库", 3, 3);
    bar.close();
    assert.deepEqual(io.writes, []);
    assert.deepEqual(io.lines, []);
});
