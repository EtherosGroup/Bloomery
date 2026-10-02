/**
 * 帮助文案，全部从命令表生成
 * @author IsCibocaz
 * @since 1.0.0
 */

import { packageVersion, runtimeVersion } from "../infra/package.ts";
import { print } from "../output/index.ts";
import type { CommandName, OptionDecls } from "./parse.ts";
import { CLI_SPEC, GLOBAL_OPTIONS } from "./spec.ts";

const NAME = "bloomery";

export function printHelp(name?: CommandName): void {
    print(name === undefined ? overview() : commandHelp(name));
}

// 版本号取自 package.json
export function printVersion(json: boolean): void {
    const version = runtimeVersion();
    print(json ? JSON.stringify({ version }, null, 4) : version);
}

function overview(): string {
    const lines = [
        "Bloomery Minecraft 启动器",
        "",
        "用法",
        `  ${NAME} [全局选项] <命令> [命令选项] [参数]`,
        "",
        "全局选项",
        ...optionLines(GLOBAL_OPTIONS),
        "",
        "命令",
    ];
    // 列宽按最长的用法串取，命令写长了也不会跟说明粘在一起
    const specs = Object.values(CLI_SPEC.commands);
    const width = Math.max(...specs.map((spec) => spec.usage.length)) + 2;
    for (const spec of specs) {
        lines.push(`  ${spec.usage.padEnd(width)}${spec.summary}`);
    }
    lines.push("", `运行 ${NAME} <命令> --help 查看命令选项`);
    return lines.join("\n");
}

function commandHelp(name: CommandName): string {
    const spec = CLI_SPEC.commands[name];
    const lines = [`${NAME} ${spec.usage}`, "", spec.summary];

    if (Object.keys(spec.options).length > 0) {
        lines.push("", "选项", ...optionLines(spec.options));
    }
    lines.push("", "全局选项", ...optionLines(GLOBAL_OPTIONS));
    return lines.join("\n");
}

function optionLines(decls: OptionDecls): string[] {
    const lines: string[] = [];
    for (const [name, decl] of Object.entries(decls)) {
        const short = decl.short === undefined ? "    " : `-${decl.short}, `;
        const value = decl.value === undefined ? "" : ` ${decl.value}`;
        lines.push(`  ${`${short}--${name}${value}`.padEnd(32)}${decl.summary}`);
    }
    return lines;
}
