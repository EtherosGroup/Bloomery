import type { ErrorCode } from "./codes.ts";

export type ErrorContext = Record<string, string | number | boolean | undefined>;

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
