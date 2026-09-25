/*
 * auth 命令：编排账户登录、登出、列表
 *
 * 目前只打印解析结果并报未实现，业务模块就位后替换函数体
 */

import { AppError } from "../../error/index.ts";
import { logger } from "../../output/index.ts";
import type { AuthCommand, Context } from "../parse.ts";

const log = logger("auth");

export async function runAuth(command: AuthCommand, ctx: Context): Promise<void> {
    log.debug("action=%s json=%s home=%s", command.action, String(ctx.json), ctx.home ?? "默认");
    throw new AppError("cli", "NotImplemented", { context: { detail: `auth ${command.action}` } });
}
