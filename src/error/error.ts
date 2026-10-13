/**
 * 错误类型
 * @author IsCibocaz
 * @since 1.0.0
 */
import type { ErrorCode } from "./codes.ts";

// 值是标量或字符串数组：数组给机器读（比如补全警告逐条列），人类可读那份按「；」拼起来
export type ErrorContext = Record<
    string,
    string | number | boolean | readonly string[] | undefined
>;

export class AppError extends Error {
    readonly prefix: string;
    readonly code: ErrorCode;
    readonly context: ErrorContext;

    constructor(
        prefix: string,
        code: ErrorCode,
        options: { cause?: unknown; context?: ErrorContext } = {},
    ) {
        super(code, { cause: options.cause });
        this.name = "AppError";
        this.prefix = prefix;
        this.code = code;
        this.context = options.context ?? {};
    }
}
