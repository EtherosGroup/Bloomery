/**
 * CLI 编排：解析 → 落全局状态 → 派发
 *
 * 命令表由映射类型保证处理器与命令一一对应，漏一个就编译不过
 * @author IsCibocaz
 * @since 1.0.0
 */

import { errorJson } from "../error/handler.ts";
import { logger, print, setLevel } from "../output/index.ts";
import { setHome } from "../platform/index.ts";
import { printHelp, printVersion } from "./help.ts";
import { parse } from "./parse.ts";
import type { Command, Context } from "./parse.ts";
import { CLI_SPEC } from "./spec.ts";

const log = logger("cli");

export async function run(argv: readonly string[]): Promise<void> {
    const parsed = parse(argv, CLI_SPEC);
    setLevel(parsed.globals.level);

    // --home 先于任何配置读取生效
    if (parsed.globals.home !== undefined && parsed.globals.home !== "") {
        setHome(parsed.globals.home);
    }

    if (parsed.kind === "help") {
        printHelp(parsed.name);
        return;
    }

    if (parsed.kind === "version") {
        printVersion(parsed.globals.json);
        return;
    }

    // 命令调用是日志文件的第一条，模块自己的 debug 默认被闸门挡着，不能指望它建文件
    log.info("命令 %s", JSON.stringify(parsed.command));

    const ctx: Context = {
        json: parsed.globals.json,
        home: parsed.globals.home,
        progress: parsed.globals.progress,
    };
    try {
        await dispatch(parsed.command, ctx);
    } catch (error) {
        // --json 时标准输出出一份机器可读的错误，人类可读的那份仍由上层写 stderr
        if (parsed.globals.json) {
            print(JSON.stringify(errorJson(error), null, 4));
        }
        throw error;
    }
}

// TS 无法关联索引访问的类型，断言集中在这一处
function dispatch(command: Command, ctx: Context): Promise<void> {
    const handler = CLI_SPEC.commands[command.name].run as (
        command: Command,
        ctx: Context,
    ) => Promise<void>;
    return handler(command, ctx);
}
