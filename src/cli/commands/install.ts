/*
 * install 命令：编排版本下载与依赖安装
 *
 * 目前只打印解析结果并报未实现，业务模块就位后替换函数体
 */

import { AppError } from "../../error/index.ts";
import { logger } from "../../output/index.ts";
import type { Context, InstallCommand } from "../parse.ts";

const log = logger("install");

export async function runInstall(command: InstallCommand, ctx: Context): Promise<void> {
    log.debug(
        "version=%s loader=%s json=%s home=%s",
        command.version,
        command.loader ?? "无",
        String(ctx.json),
        ctx.home ?? "默认",
    );
    throw new AppError("cli", "NotImplemented", { context: { detail: "install" } });
}
