/**
 * 错误出口：把任意抛出的东西变成面向用户的信息与退出码
 *
 * context.detail 放面向用户的那句话，其余键作为补充信息拼在后面
 * 已知失败是给用户读的，走 printError 不加时间戳
 * 未知失败是 bug，先记一条带时间戳的日志再打栈，栈留给反馈用
 * @author IsCibocaz
 * @since 1.0.0
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
    ConfigTooNew: "配置版本比程序新",
    FolderNotFound: "游戏文件夹不存在",
    FolderUnusable: "游戏文件夹不可用",
    FolderDuplicate: "游戏文件夹已经添加过",
    VersionNotFound: "版本不存在",
    VersionBroken: "版本文件读不出来",
    VersionExists: "版本已经存在",
    JavaNotFound: "找不到可用的 Java",
    JavaBroken: "Java 跑不起来",
    JavaDuplicate: "这个 Java 已经在清单里",
    DependencyMissing: "依赖文件缺失",
    DownloadFailed: "下载失败",
    AccountNotFound: "找不到可用的账户",
    AccountExpired: "账户凭据需要刷新",
    LaunchFailed: "游戏进程没起来",
};

// 退出码约定：0 成功，1 内部错误，2 用法错误，3 未实现
const EXIT_CODES: Record<ErrorCode, number> = {
    UnknownError: 1,
    UsageError: 2,
    UnknownCommand: 2,
    NotImplemented: 3,
    ConfigTooNew: 1,
    FolderNotFound: 1,
    FolderUnusable: 1,
    FolderDuplicate: 1,
    VersionNotFound: 1,
    VersionBroken: 1,
    VersionExists: 1,
    JavaNotFound: 1,
    JavaBroken: 1,
    JavaDuplicate: 1,
    DependencyMissing: 1,
    DownloadFailed: 1,
    AccountNotFound: 1,
    AccountExpired: 1,
    LaunchFailed: 1,
};

const HINTS: Partial<Record<ErrorCode, string>> = {
    UsageError: "运行 bloomery --help 查看用法",
    UnknownCommand: "运行 bloomery --help 查看全部命令",
    ConfigTooNew: "配置文件是更新版本的 Bloomery 写的，本次运行不会写回",
    FolderNotFound: "运行 bloomery folder list 查看已添加的文件夹，folder add <目录> 添加",
    FolderDuplicate: "运行 bloomery folder list 查看已添加的文件夹",
    VersionNotFound: "运行 bloomery version list 查看可用版本",
    JavaNotFound: "运行 bloomery java scan 扫描本机的 Java",
    JavaDuplicate: "运行 bloomery java list 查看已记录的 Java",
    AccountNotFound: "运行 bloomery auth login 添加账户，或用 --account <名字> 指定",
    AccountExpired: "运行 bloomery auth login 重新登录",
    VersionExists: "换一个 --name，或先删掉已有的那份",
    DownloadFailed: "检查网络，或设置里的下载源与代理",
};

export function handleError(error: unknown, logPath?: string): number {
    if (!(error instanceof AppError)) {
        log.error("内部错误 %s", error instanceof Error ? error.message : String(error));
        printError("错误：内部错误，这是 bug，请附带下面的调用栈反馈");
        printError(format(error));
        printLogPath(logPath);
        return EXIT_CODES.UnknownError;
    }

    printError(`错误：${messageOf(error)}${detailOf(error)}`);

    const cause = error.cause;
    if (cause instanceof Error) {
        printError(`原因：${cause.message}`);
    }
    const hint = HINTS[error.code];
    if (hint !== undefined) {
        printError(hint);
    }
    printLogPath(logPath, error.code);
    return EXIT_CODES[error.code];
}

// 用法类错误在抛出前还没写出日志，给路径反而指向一个不存在的文件
function printLogPath(logPath: string | undefined, code?: ErrorCode): void {
    if (logPath === undefined || code === "UsageError" || code === "UnknownCommand") {
        return;
    }
    printError(`详细日志：${logPath}`);
}

// context.text 直接给出整句，文案里带数据时用它
function messageOf(error: AppError): string {
    const text = error.context["text"];
    return text === undefined ? MESSAGES[error.code] : String(text);
}

// detail 是主细节，其余上下文键作为补充
function detailOf(error: AppError): string {
    const entries = Object.entries(error.context).filter(
        ([key, value]) => value !== undefined && key !== "text",
    );
    const detail = entries.find(([key]) => key === "detail")?.[1];
    const rest = entries
        .filter(([key]) => key !== "detail")
        .map(([key, value]) => `${key}=${String(value)}`);

    const head = detail === undefined ? "" : `：${String(detail)}`;
    return rest.length === 0 ? head : `${head}（${rest.join(" ")}）`;
}
