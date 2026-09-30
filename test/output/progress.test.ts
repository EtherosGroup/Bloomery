/**
 * 进度条：条的渲染、换阶段、节流、非交互与关掉
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    liveColumns,
    progressReporter,
    renderBar,
    type ProgressIo,
    type TerminalStream,
} from "../../src/output/progress.ts";
import { displayWidth } from "../../src/output/text.ts";

interface Fake extends ProgressIo {
    readonly writes: string[];
    readonly lines: string[];
}

function fakeIo(overrides: Partial<ProgressIo> = {}): Fake {
    const writes: string[] = [];
    const lines: string[] = [];
    return {
        interactive: true,
        columns: 41,
        width: 40,
        write: (text) => writes.push(text),
        line: (text) => lines.push(text),
        writes,
        lines,
        ...overrides,
    };
}

// 列数可以在跑到一半时改，用来模拟拖动终端窗口
function resizableIo(): { io: Fake; resize: (columns: number) => void } {
    const writes: string[] = [];
    const lines: string[] = [];
    let columns = 101;
    return {
        io: {
            interactive: true,
            get columns(): number {
                return columns;
            },
            get width(): number {
                return columns - 1;
            },
            write: (text) => writes.push(text),
            line: (text) => lines.push(text),
            writes,
            lines,
        },
        resize: (next) => {
            columns = next;
        },
    };
}

test("条的宽度与填充", () => {
    // 中文标签占两格，整行按显示宽度对齐
    assert.equal(displayWidth("资源"), 4);
    assert.equal(displayWidth("natives"), 7);

    const half = renderBar("资源", 50, 100, 60);
    assert.equal(displayWidth(half), 60);
    assert.match(half, /^\[#{15} {15}\]  50% 资源/);

    // 百分比位数变化时条不伸缩，括号里始终一样宽
    const empty = renderBar("库", 0, 10, 60);
    const full = renderBar("库", 10, 10, 60);
    assert.equal(displayWidth(empty), 60);
    assert.equal(displayWidth(full), 60);
    assert.match(empty, /^\[ {30}\]   0% 库/);
    assert.match(full, /^\[#{30}\] 100% 库/);
});

test("阶段名宽窄不影响条的长短", () => {
    const short = renderBar("库", 30, 100, 60);
    const long = renderBar("客户端 jar", 30, 100, 60);

    // 右括号落在同一列，填充长度也一致
    assert.equal(short.indexOf("]"), long.indexOf("]"));
    assert.equal(displayWidth(short), displayWidth(long));
});

test("后缀预留了位置，带不带后缀一样宽", () => {
    const plain = renderBar("库", 47, 47, 80, "");
    const noted = renderBar("库", 47, 47, 80, "（已存在）");

    assert.equal(displayWidth(plain), 80);
    assert.equal(displayWidth(noted), 80);
    assert.equal(plain.indexOf("]"), noted.indexOf("]"));
    // 后缀占的宽度从条里扣，行宽不会超出去
    assert.equal(displayWidth("（已存在）"), 10);
});

test("总共未知时按满算", () => {
    assert.match(renderBar("库", 0, 0, 60), /100%/);
});

test("列数现问句柄，问不到才退回缓存值", () => {
    // 第一次问报 120，后来报 60，模拟拖动窗口
    let width = 120;
    const stream: TerminalStream = {
        columns: 120,
        _handle: {
            getWindowSize: (size) => {
                size[0] = width;
                size[1] = 30;
                return 0;
            },
        },
    };
    assert.equal(liveColumns(stream), 120);
    width = 60;
    assert.equal(liveColumns(stream), 60);

    // 不是终端：句柄上没有这个方法
    assert.equal(liveColumns({ columns: 100 }), null);
    // 句柄报错
    assert.equal(liveColumns({ columns: 100, _handle: { getWindowSize: () => -1 } }), null);
    // 句柄抛异常
    assert.equal(
        liveColumns({
            columns: 100,
            _handle: {
                getWindowSize: () => {
                    throw new Error("不是终端");
                },
            },
        }),
        null,
    );
});

test("终端再窄也不让整行超出去", () => {
    // 行宽超出去终端会折行，光标落点就全错了
    for (const width of [8, 12, 20, 24, 30, 41]) {
        assert.equal(displayWidth(renderBar("客户端 jar", 50, 100, width, "（已存在）")), width);
    }

    // 30 格：后缀让位，阶段名留着
    assert.match(renderBar("客户端 jar", 50, 100, 30, "（已存在）"), /\]  50% 客户端 jar$/);
    // 20 格：阶段名也让位，只剩百分比
    const narrow = renderBar("客户端 jar", 50, 100, 20, "（已存在）");
    assert.match(narrow, /^\[#{6} {6}\] {2}50% $/);
    assert.equal(displayWidth(narrow), 20);
});

test("终端改大小后先擦掉被折行的旧帧", () => {
    const { io, resize } = resizableIo();
    const bar = progressReporter("bar", io);

    // 第一帧没有东西要清
    bar.update("资源", 0, 100);
    assert.match(io.writes[0] ?? "", /^\[/);

    // 100 格的旧帧在 41 列下会折成 3 行：退回 2 行，再整片擦掉
    resize(41);
    bar.update("资源", 50, 100);
    const cleaned = io.writes[1] ?? "";
    assert.match(cleaned, /^\u001b\[2A\r\u001b\[J/);
    assert.equal(displayWidth(cleaned.replace(/^\u001b\[2A\r\u001b\[J/, "")), 40);

    // 宽度没再变就只擦这一行
    bar.update("资源", 60, 100);
    assert.match(io.writes[2] ?? "", /^\r\u001b\[J\[/);
});

test("两条通道各占一行，同一个块里一起刷新", () => {
    const { io } = resizableIo();
    const bar = progressReporter("bar", io);

    bar.update("库", 0, 100);
    bar.update("natives", 0, 100);
    bar.update("库", 50, 100);

    // 后一帧是两行：库 与 natives 同时重画
    const frame = io.writes.at(-1) ?? "";
    const parts = frame.split("\n");
    assert.equal(parts.length, 2);
    assert.match(parts[0] ?? "", /50% 库\s*$/);
    assert.match(parts[1] ?? "", /0% natives\s*$/);
    // 上一块两行，重画前退一行
    assert.match(frame, /^\u001b\[1A\r\u001b\[J/);
});

test("一批文件全是已有的，后缀跟着收尾那一帧", () => {
    const io = fakeIo();
    const bar = progressReporter("bar", io);

    bar.update("库", 47, 47, false, true);
    assert.match(io.writes.at(-1) ?? "", /100% 库\s*（已存在）/);

    // 中间帧不带
    const mid = fakeIo();
    const other = progressReporter("bar", mid);
    other.update("库", 20, 47, false, false);
    assert.doesNotMatch(mid.writes.at(-1) ?? "", /已存在/);
});

test("非交互时后缀也带上", () => {
    const io = fakeIo({ interactive: false });
    const bar = progressReporter("bar", io);

    bar.update("库", 47, 47, false, true);
    bar.update("natives", 8, 8, false, false);
    bar.close();

    assert.deepEqual(io.lines, ["库 47/47（已存在）", "natives 8/8"]);
});

test("两条通道重画时退两行，收尾留一块在屏幕上", () => {
    const io = fakeIo({ columns: 41, width: 40 });
    const bar = progressReporter("bar", io);

    bar.update("客户端 jar", 0, 100);
    bar.update("库", 0, 100);
    // 上一块两行，重画前退一行再整片擦掉
    bar.update("客户端 jar", 100, 100);
    assert.match(io.writes.at(-1) ?? "", /^\u001b\[1A\r\u001b\[J/);

    bar.close();
    // 收尾只补一个换行，条留在屏幕上
    assert.equal(io.writes.filter((text) => text === "\n").length, 1);
    const last = io.writes.at(-2) ?? "";
    assert.equal(last.split("\n").length, 2);
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
