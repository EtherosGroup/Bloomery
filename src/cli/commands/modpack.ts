/*
 * modpack 命令：编排整合包导入
 *
 * 目前只打印解析结果并报未实现，业务模块就位后替换函数体
 */

import { AppError } from "../../error/index.ts";
import { logger } from "../../output/index.ts";
import type { Context, ModpackCommand } from "../parse.ts";

const log = logger("modpack");

export async function runModpack(command: ModpackCommand, ctx: Context): Promise<void> {
    log.debug("file=%s json=%s home=%s", command.file, String(ctx.json), ctx.home ?? "默认");
    throw new AppError("cli", "NotImplemented", { context: { detail: "modpack" } });
}
