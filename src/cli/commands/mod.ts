/*
 * mod 命令：编排 MOD 检索与安装
 *
 * 目前只打印解析结果并报未实现，业务模块就位后替换函数体
 */

import { AppError } from "../../error/index.ts";
import { logger } from "../../output/index.ts";
import type { Context, ModCommand } from "../parse.ts";

const log = logger("mod");

export async function runMod(command: ModCommand, ctx: Context): Promise<void> {
    log.debug(
        "action=%s query=%s json=%s home=%s",
        command.action,
        command.query,
        String(ctx.json),
        ctx.home ?? "默认",
    );
    throw new AppError("cli", "NotImplemented", { context: { detail: `mod ${command.action}` } });
}
