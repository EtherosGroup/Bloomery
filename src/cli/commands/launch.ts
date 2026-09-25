/*
 * launch 命令：编排版本、依赖、账户、启动
 *
 * 目前只打印解析结果并报未实现，业务模块就位后替换函数体
 */

import { AppError } from "../../error/index.ts";
import { logger } from "../../output/index.ts";
import type { Context, LaunchCommand } from "../parse.ts";

const log = logger("launch");

export async function runLaunch(command: LaunchCommand, ctx: Context): Promise<void> {
    log.debug(
        "version=%s account=%s json=%s home=%s",
        command.version ?? "默认",
        command.account ?? "默认",
        String(ctx.json),
        ctx.home ?? "默认",
    );
    throw new AppError("cli", "NotImplemented", { context: { detail: "launch" } });
}
