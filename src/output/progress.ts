/**
 * 进度条
 *
 * 只在能原地刷新的终端上画条；管道里退化成按阶段报数，关掉时什么都不输出
 * 整行顶满终端宽度，阶段名接在百分比后面，换阶段时长度不会跳
 * @author IsCibocaz
 * @since 1.0.0
 */

import { print, quiet, writeOut } from "./output.ts";
import { displayWidth } from "./text.ts";

/** 拿不到终端列数时的保底宽度 */
const FALLBACK_WIDTH = 100;

/** 非交互时每多少个文件报一次 */
const STEP = 256;

/** 非交互且按字节报时，每百分之几报一次 */
const PLAIN_STEP = 5;

/** ndjson 事件的最小间隔，10 条/秒；消费端慢时靠背压再丢 */
export const EMIT_INTERVAL_MS = 100;

/** stderr 积压超过这么多字节就丢中间帧 */
export const EMIT_BACKLOG = 64 * 1024;

/** 条最少要留这么宽，标签太长也不会把条挤没 */
const MIN_INNER = 10;

/** 阶段名按显示宽度补齐到这个宽度，条的长短才不受阶段名影响 */
const LABEL_WIDTH = 12;

/** 后缀「（已存在）」占的显示宽度；先留出来，带后缀那行的条才不会短一截 */
const NOTE_WIDTH = 10;

/** 终端窄到这个宽度以下就按这个来，只防列数报 0 或 1 这类怪值 */
const MIN_WIDTH = 8;

/** 已存在就什么都不用下，收尾时挂上这个后缀 */
export const EXISTING_NOTE = "（已存在）";

export type ProgressStyle = "bar" | "plain" | "off" | "ndjson";

export interface ProgressIo {
    readonly interactive: boolean;
    /** 终端当前的列数，判断上一帧现在占几行用 */
    readonly columns: number;
    /** 一次渲染用的整行宽度，每次渲染都重新取，终端改大小能跟上 */
    readonly width: number;
    /** 原地写一行，不带换行 */
    write(text: string): void;
    /** 另起一行 */
    line(text: string): void;
    /** 逐行事件走 stderr，返回 false 表示消费端慢、这一帧该丢；ndjson 用 */
    emit?(text: string, force?: boolean): boolean;
}

export interface ProgressReporter {
    /** bytes 为 true 时 done 与 total 是字节数；existing 表示这批全是已有的 */
    update(stage: string, done: number, total: number, bytes?: boolean, existing?: boolean): void;
    /** 收尾：让最后一条进度留在屏幕上 */
    close(): void;
}

export function terminalIo(): ProgressIo {
    const columns = (): number => liveColumns() ?? process.stdout.columns ?? FALLBACK_WIDTH;
    return {
        interactive: process.stdout.isTTY === true && !quiet(),
        get columns(): number {
            return columns();
        },
        // 顶满终端；留一格，避免写到最后一列时自动换行
        get width(): number {
            return Math.max(MIN_WIDTH, columns() - 1);
        },
        write: writeOut,
        line: print,
        // 背压：消费端慢了就丢中间帧，收尾那条强制写
        emit: (text: string, force = false): boolean => {
            if (!force && process.stderr.writableLength > EMIT_BACKLOG) {
                return false;
            }
            process.stderr.write(text);
            return true;
        },
    };
}

/** 只用到列数与 tty 句柄，方便测试给替身 */
export interface TerminalStream {
    readonly columns?: number | undefined;
    readonly _handle?: { getWindowSize?(size: number[]): number } | undefined;
}

// 实时问一次列数
// columns 是缓存值，靠 resize 事件刷新，而 Windows 控制台改大小不一定发得出来；句柄上的这个方法是现问现答
// 不在终端上、或句柄没有这个方法时返回 null，交给调用方退回缓存值
export function liveColumns(stream: TerminalStream = process.stdout): number | null {
    const size = [0, 0];
    try {
        const error = stream._handle?.getWindowSize?.(size);
        const width = size[0];
        if (error !== 0 || width === undefined || !Number.isFinite(width)) {
            return null;
        }
        return Math.max(0, Math.floor(width));
    } catch {
        return null;
    }
}

export function progressReporter(
    style: ProgressStyle,
    io: ProgressIo = terminalIo(),
): ProgressReporter {
    const bar = style === "bar" && io.interactive;
    // 每条通道一行条，同时刷新；顺序按第一次出现的先后
    const lanes = new Map<string, { done: number; total: number; note: string; percent: number }>();
    // 上一条 ndjson 事件的时刻，用来节流
    let lastEmitAt = 0;

    // 上一帧每行的显示宽度；用当前列数重算折成几行，终端改大小时光标才对得上
    let drawnWidths: number[] = [];

    const clearBlock = (): string => {
        if (drawnWidths.length === 0) {
            return "";
        }
        const columns = Math.max(1, io.columns);
        const rows = drawnWidths.reduce(
            (sum, width) => sum + Math.max(1, Math.ceil(width / columns)),
            0,
        );
        drawnWidths = [];
        return `${rows > 1 ? `\u001b[${rows - 1}A` : ""}\r\u001b[J`;
    };

    return {
        update(next: string, done: number, total: number, bytes = false, existing = false): void {
            if (style === "off" || total <= 0) {
                return;
            }

            const first = !lanes.has(next);
            const lane = lanes.get(next) ?? { done: 0, total, note: "", percent: -1 };
            lane.done = done;
            lane.total = total;
            lane.note = existing ? EXISTING_NOTE : "";
            const percent = Math.floor((done * 100) / total);

            // 机器可读：一行一个 JSON 事件，节流 + 背压，收尾与新阶段必发
            if (style === "ndjson") {
                lane.percent = percent;
                lanes.set(next, lane);
                const force = first || percent >= 100;
                if (!force && Date.now() - lastEmitAt < EMIT_INTERVAL_MS) {
                    return;
                }
                const payload = {
                    v: 1,
                    stage: next,
                    done,
                    total,
                    bytes,
                    ...(existing ? { existing: true } : {}),
                };
                if (io.emit === undefined) {
                    return;
                }
                if (!io.emit(`${JSON.stringify(payload)}\n`, force) && !force) {
                    return;
                }
                lastEmitAt = Date.now();
                return;
            }

            if (!bar) {
                // 管道里只能逐条打印，各通道的进度会交错
                if (bytes) {
                    if (
                        done !== total &&
                        lane.percent >= 0 &&
                        percent - lane.percent < PLAIN_STEP
                    ) {
                        lanes.set(next, lane);
                        return;
                    }
                    lane.percent = percent;
                    lanes.set(next, lane);
                    io.line(`${next} ${sizeText(done)}/${sizeText(total)}${lane.note}`);
                    return;
                }
                lane.percent = percent;
                lanes.set(next, lane);
                if (done === total || done % STEP === 0) {
                    io.line(`${next} ${done}/${total}${lane.note}`);
                }
                return;
            }

            // 同一个百分比不重复刷，最后一步必刷
            if (percent === lane.percent && done !== total && lane.percent >= 0) {
                return;
            }
            lane.percent = percent;
            lanes.set(next, lane);

            // 宽度只取一次：两次读取之间终端可能又变了，条与清理就对不上
            const width = io.width;
            const lines = [...lanes].map(([name, item]) =>
                renderBar(name, item.done, item.total, width, item.note),
            );
            io.write(`${clearBlock()}${lines.join("\n")}`);
            drawnWidths = lines.map(displayWidth);
        },

        close(): void {
            if (bar && drawnWidths.length > 0) {
                io.write("\n");
                drawnWidths = [];
            }
        },
    };
}

function sizeText(value: number): string {
    return value >= 1024 * 1024
        ? `${(value / 1024 / 1024).toFixed(1)}MB`
        : `${Math.round(value / 1024)}KB`;
}

// [####      ] 42% 资源
export function renderBar(
    label: string,
    done: number,
    total: number,
    width: number,
    note?: string,
): string {
    const percent = total <= 0 ? 100 : Math.min(100, Math.floor((done * 100) / total));
    // 百分比补齐到三位，位数变化时条不伸缩
    // 阶段名与后缀都按显示宽度补齐，阶段名或后缀变了条也一样长
    // 宽度不够就一层层让位，宁可丢掉阶段名，也不让整行超出终端——超出去会被终端折行，后面的帧全糊
    const mark = `] ${String(percent).padStart(3)}%`;
    const tails = [
        `${mark} ${padLabel(label)}${padNote(note)}`,
        `${mark} ${label}${note ?? ""}`,
        `${mark} ${label}`,
        `${mark} `,
    ];
    const tail = tails.find((text) => 1 + MIN_INNER + displayWidth(text) <= width) ?? `${mark} `;
    const inner = Math.max(0, width - 1 - displayWidth(tail));
    const filled = Math.round((inner * percent) / 100);

    return `[${"#".repeat(filled)}${" ".repeat(inner - filled)}${tail}`;
}

function padLabel(label: string): string {
    const pad = LABEL_WIDTH - displayWidth(label);
    return pad > 0 ? `${label}${" ".repeat(pad)}` : label;
}

function padNote(note: string | undefined): string {
    const text = note ?? "";
    const pad = NOTE_WIDTH - displayWidth(text);
    return pad > 0 ? `${text}${" ".repeat(pad)}` : text;
}
