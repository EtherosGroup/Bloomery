/*
 * CLI 编排：解析 → 落全局状态 → 派发
 *
 * 命令表由映射类型保证处理器与命令一一对应，漏一个就编译不过
 */

import { setLevel } from "../output/index.ts";
import { printHelp } from "./help.ts";
import { parse } from "./parse.ts";
import type { Command, Context } from "./parse.ts";
import { CLI_SPEC } from "./spec.ts";

export async function run(argv: readonly string[]): Promise<void> {
    const parsed = parse(argv, CLI_SPEC);
    setLevel(parsed.globals.level);

    if (parsed.kind === "help") {
        printHelp(parsed.name);
        return;
    }

    const ctx: Context = { json: parsed.globals.json, home: parsed.globals.home };
    await dispatch(parsed.command, ctx);
}

// TS 无法关联索引访问的类型，断言集中在这一处
function dispatch(command: Command, ctx: Context): Promise<void> {
    const handler = CLI_SPEC.commands[command.name].run as (
        command: Command,
        ctx: Context,
    ) => Promise<void>;
    return handler(command, ctx);
}
