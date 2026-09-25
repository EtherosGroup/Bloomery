/*
 * 命令表：命令名、选项、位置参数、帮助文案、处理器
 *
 * 唯一的命令清单，帮助文案与两级解析都从这里取
 */

import { runAuth } from "./commands/auth.ts";
import { runInstall } from "./commands/install.ts";
import { runLaunch } from "./commands/launch.ts";
import { runMod } from "./commands/mod.ts";
import { runModpack } from "./commands/modpack.ts";
import {
    optionalPositional,
    optionalString,
    requireChoice,
    requirePositional,
    type CliSpec,
    type CommandTable,
    type OptionDecls,
} from "./parse.ts";

export const GLOBAL_OPTIONS: OptionDecls = {
    verbose: { type: "boolean", short: "v", summary: "输出调试日志" },
    quiet: { type: "boolean", short: "q", summary: "只输出警告与错误" },
    json: { type: "boolean", summary: "以 JSON 输出结果" },
    home: { type: "string", value: "<dir>", summary: "指定数据目录" },
    help: { type: "boolean", short: "h", summary: "显示帮助" },
};

export const COMMANDS: CommandTable = {
    launch: {
        summary: "启动游戏",
        usage: "launch [version] [--account <name>]",
        options: {
            account: { type: "string", value: "<name>", summary: "使用指定账户" },
        },
        positionals: { names: ["version"], required: 0 },
        toCommand: (values, positionals) => ({
            name: "launch",
            version: optionalPositional(positionals, 0, "version"),
            account: optionalString(values, "account"),
        }),
        run: runLaunch,
    },

    install: {
        summary: "安装指定版本",
        usage: "install <version> [--loader <name>]",
        options: {
            loader: { type: "string", value: "<name>", summary: "同时安装模组加载器" },
        },
        positionals: { names: ["version"], required: 1 },
        toCommand: (values, positionals) => ({
            name: "install",
            version: requirePositional(positionals, 0, "version"),
            loader: optionalString(values, "loader"),
        }),
        run: runInstall,
    },

    auth: {
        summary: "账户管理",
        usage: "auth <login|logout|list>",
        options: {},
        positionals: { names: ["action"], required: 1 },
        toCommand: (_values, positionals) => ({
            name: "auth",
            action: requireChoice(
                requirePositional(positionals, 0, "action"),
                ["login", "logout", "list"] as const,
                "action",
            ),
        }),
        run: runAuth,
    },

    mod: {
        summary: "MOD 检索与安装",
        usage: "mod <search|install> <query>",
        options: {},
        positionals: { names: ["action", "query"], required: 2 },
        toCommand: (_values, positionals) => ({
            name: "mod",
            action: requireChoice(
                requirePositional(positionals, 0, "action"),
                ["search", "install"] as const,
                "action",
            ),
            query: requirePositional(positionals, 1, "query"),
        }),
        run: runMod,
    },

    modpack: {
        summary: "导入整合包",
        usage: "modpack <file>",
        options: {},
        positionals: { names: ["file"], required: 1 },
        toCommand: (_values, positionals) => ({
            name: "modpack",
            file: requirePositional(positionals, 0, "file"),
        }),
        run: runModpack,
    },
};

export const CLI_SPEC: CliSpec = { globals: GLOBAL_OPTIONS, commands: COMMANDS };
