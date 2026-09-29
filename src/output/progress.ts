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

export type ProgressStyle = "bar" | "plain" | "off";

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
    let stage: string | undefined;
    let shown = -1;
    let plainShown = -1;
    // 上一帧画了多宽，用来看终端有没有改过大小；0 表示当前这行还没有东西
    let frameWidth = 0;

    // 重画前要发的控制序列
    // 平时只擦掉行尾：帧比终端窄时（终端刚变小）不会留下上一帧的长尾巴
    // 终端改过大小的话，上一帧现在会被折成好几行，光标也落在折行块中间，得先退回那一块的第一行再整片擦掉
    const redraw = (width: number): string => {
        if (frameWidth !== 0 && width !== frameWidth) {
            const rows = Math.max(1, Math.ceil(frameWidth / Math.max(1, io.columns)));
            frameWidth = width;
            return `${rows > 1 ? `\u001b[${rows - 1}A` : ""}\u001b[J`;
        }
        frameWidth = width;
        return "\u001b[K";
    };

    return {
        update(next: string, done: number, total: number, bytes = false, existing = false): void {
            if (style === "off" || total <= 0) {
                return;
            }

            if (next !== stage) {
                // 上一个阶段那一行留在屏幕上，新阶段另起一行，不用回头清理
                if (stage !== undefined && bar) {
                    io.write("\n");
                    frameWidth = 0;
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
                // 宽度只取一次：两次读取之间终端可能又变了，条与清理就对不上
                const width = io.width;
                io.write(`\r${redraw(width)}${renderBar(next, done, total, width, note)}`);
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
