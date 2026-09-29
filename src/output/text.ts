/**
 * 终端文本的小工具
 * @author IsCibocaz
 * @since 1.0.0
 */

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
