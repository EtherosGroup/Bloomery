/*
 * 错误出口：把任意抛出的东西变成面向用户的信息与退出码
 *
 * context.detail 放面向用户的那句话，其余键作为补充信息拼在后面
 * 已知失败是给用户读的，走 printError 不加时间戳
 * 未知失败是 bug，先记一条带时间戳的日志再打栈，栈留给反馈用
 */

import { format } from "node:util";

import { logger, printError } from "../output/index.ts";
import type { ErrorCode } from "./codes.ts";
import { AppError } from "./error.ts";

const log = logger("ErrorHandler");

const MESSAGES: Record<ErrorCode, string> = {
    UnknownError: "内部错误",
    UsageError: "参数不合法",
    UnknownCommand: "未知命令",
    NotImplemented: "该功能尚未实现",
};

// 退出码约定：0 成功，1 内部错误，2 用法错误，3 未实现
const EXIT_CODES: Record<ErrorCode, number> = {
    UnknownError: 1,
    UsageError: 2,
    UnknownCommand: 2,
    NotImplemented: 3,
};

const HINTS: Partial<Record<ErrorCode, string>> = {
    UsageError: "运行 bloomery --help 查看用法",
    UnknownCommand: "运行 bloomery --help 查看全部命令",
};

export function handleError(error: unknown): number {
    if (!(error instanceof AppError)) {
        log.error("内部错误 %s", error instanceof Error ? error.message : String(error));
        printError("错误：内部错误，这是 bug，请附带下面的调用栈反馈");
        printError(format(error));
        return EXIT_CODES.UnknownError;
    }

    printError(`错误：${MESSAGES[error.code]}${detailOf(error)}`);

    const cause = error.cause;
    if (cause instanceof Error) {
        printError(`原因：${cause.message}`);
    }
    const hint = HINTS[error.code];
    if (hint !== undefined) {
        printError(hint);
    }
    return EXIT_CODES[error.code];
}

// detail 是主细节，其余上下文键作为补充
function detailOf(error: AppError): string {
    const entries = Object.entries(error.context).filter(([, value]) => value !== undefined);
    const detail = entries.find(([key]) => key === "detail")?.[1];
    const rest = entries
        .filter(([key]) => key !== "detail")
        .map(([key, value]) => `${key}=${String(value)}`);

    const head = detail === undefined ? "" : `：${String(detail)}`;
    return rest.length === 0 ? head : `${head}（${rest.join(" ")}）`;
}
