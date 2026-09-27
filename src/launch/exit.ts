/**
 * 退出码归一化
 *
 * 正常退出用进程自己的码；被信号杀掉按 128 + 信号号，与 shell 的约定一致
 * @author IsCibocaz
 * @since 1.0.0
 */

import { constants } from "node:os";

const SIGNALS: Readonly<Record<string, number>> = constants.signals;

export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
    if (signal !== null) {
        return 128 + (SIGNALS[signal] ?? 0);
    }
    return code ?? 0;
}
