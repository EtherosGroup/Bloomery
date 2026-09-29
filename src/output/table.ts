/**
 * 表格输出
 *
 * 列宽按每列最宽的单元格取，按显示宽度对齐，CJK 算两格
 * 最后一列不补空格：长字段放最后，就不会把别的列推得参差不齐
 * @author IsCibocaz
 * @since 1.0.0
 */

import { displayWidth } from "./text.ts";

export interface TableOptions {
    /** 列名，作为第 0 行输出；列宽把它一起算进去 */
    readonly header?: readonly string[];
    /** 列间空格数 */
    readonly gap?: number;
    /** 每行开头的缩进 */
    readonly indent?: string;
    /** 右对齐的列下标，数字列用 */
    readonly right?: readonly number[];
}

export function renderTable(
    rows: readonly (readonly string[])[],
    options: TableOptions = {},
): string[] {
    const gap = options.gap ?? 2;
    const indent = options.indent ?? "";
    const right = new Set(options.right ?? []);
    const all = options.header === undefined ? rows : [options.header, ...rows];

    const widths: number[] = [];
    for (const row of all) {
        row.forEach((cell, at) => {
            widths[at] = Math.max(widths[at] ?? 0, displayWidth(cell));
        });
    }

    return all.map((row) => {
        const parts: string[] = [];
        row.forEach((cell, at) => {
            if (at === row.length - 1) {
                parts.push(cell);
                return;
            }
            const spare = (widths[at] ?? 0) - displayWidth(cell);
            parts.push(
                right.has(at)
                    ? `${" ".repeat(spare)}${cell}${" ".repeat(gap)}`
                    : `${cell}${" ".repeat(spare + gap)}`,
            );
        });
        // 末列空着时不留一截尾空格
        return (indent + parts.join("")).replace(/[ \t]+$/, "");
    });
}
