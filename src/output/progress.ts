/**
 * 进度条
 *
 * 只在能原地刷新的终端上画条；管道里退化成按阶段报数，关掉时什么都不输出
 * 整行顶满终端宽度，阶段名接在百分比后面，换阶段时长度不会跳
 * @author IsCibocaz
 * @since 1.0.0
 */

import { print, quiet, writeOut } from "./output.ts";

/** 拿不到终端列数时的保底宽度 */
const FALLBACK_WIDTH = 100;

/** 非交互时每多少个文件报一次 */
const STEP = 256;

/** 非交互且按字节报时，每百分之几报一次 */
const PLAIN_STEP = 5;

/** 条最少要留这么宽，标签太长也不会把条挤没 */
const MIN_INNER = 10;

/** 阶段名按显示宽度补齐到这个宽度，条的长短才不受阶段名影响 */
const LABEL_WIDTH = 12;

/** 后缀「（已存在）」占的显示宽度；先留出来，带后缀那行的条才不会短一截 */
const NOTE_WIDTH = 10;

/** 终端小到这个宽度以下就按这个来 */
const MIN_WIDTH = 40;

/** 已存在就什么都不用下，收尾时挂上这个后缀 */
export const EXISTING_NOTE = "（已存在）";

export type ProgressStyle = "bar" | "plain" | "off";

export interface ProgressIo {
    readonly interactive: boolean;
    /** 一次渲染用的整行宽度，每次渲染都重新取，终端改大小能跟上 */
    readonly width: number;
    /** 原地写一行，不带换行 */
    write(text: string): void;
    /** 另起一行 */
    line(text: string): void;
}

export interface ProgressReporter {
    /** bytes 为 true 时 done 与 total 是字节数；existing 表示这批全是已有的 */
    update(stage: string, done: number, total: number, bytes?: boolean, existing?: boolean): void;
    /** 收尾：让最后一条进度留在屏幕上 */
    close(): void;
}

export function terminalIo(): ProgressIo {
    return {
        interactive: process.stdout.isTTY === true && !quiet(),
        // 顶满终端；留一格，避免写到最后一列时自动换行
        get width(): number {
            const columns = process.stdout.columns ?? FALLBACK_WIDTH;
            return Math.max(MIN_WIDTH, columns - 1);
        },
        write: writeOut,
        line: print,
    };
}

export function progressReporter(
    style: ProgressStyle,
    io: ProgressIo = terminalIo(),
): ProgressReporter {
    const bar = style === "bar" && io.interactive;
    let stage: string | undefined;
    let shown = -1;
    let plainShown = -1;

    return {
        update(next: string, done: number, total: number, bytes = false, existing = false): void {
            if (style === "off" || total <= 0) {
                return;
            }

            if (next !== stage) {
                // 上一个阶段那一行留在屏幕上
                if (stage !== undefined && bar) {
                    io.write("\n");
                }
                stage = next;
                shown = -1;
                plainShown = -1;
            }

            const percent = Math.floor((done * 100) / total);
            const note = existing ? EXISTING_NOTE : "";

            if (bar) {
                // 同一个百分比不重复刷，最后一步必刷
                if (percent === shown && done !== total) {
                    return;
                }
                shown = percent;
                io.write(`\r${renderBar(next, done, total, io.width, note)}`);
                return;
            }

            // 按字节报时没法按个数数，改成每 5% 报一次，阶段第一帧必报
            if (bytes) {
                if (done !== total && plainShown >= 0 && percent - plainShown < PLAIN_STEP) {
                    return;
                }
                plainShown = percent;
                io.line(`${next} ${sizeText(done)}/${sizeText(total)}${note}`);
                return;
            }

            if (done === total || done % STEP === 0) {
                io.line(`${next} ${done}/${total}${note}`);
            }
        },

        close(): void {
            if (bar && stage !== undefined) {
                io.write("\n");
            }
        },
    };
}

// 字节数用人看的单位
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
    // 标签与后缀都按显示宽度补齐，阶段名或后缀变了条也一样长
    const tail = `] ${String(percent).padStart(3)}% ${padLabel(label)}${padNote(note)}`;
    const inner = Math.max(MIN_INNER, width - 1 - displayWidth(tail));
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

// 终端里的列宽：CJK 与全角占两格，其余一格
export function displayWidth(text: string): number {
    let width = 0;
    for (const char of text) {
        width += wide(char.codePointAt(0) ?? 0) ? 2 : 1;
    }
    return width;
}

function wide(code: number): boolean {
    return (
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x3fffd)
    );
}
