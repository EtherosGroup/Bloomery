/**
 * 命令表：命令名、选项、位置参数、帮助文案、处理器
 *
 * 唯一的命令清单，帮助文案与两级解析都从这里取
 * @author IsCibocaz
 * @since 1.0.0
 */

import { runAuth } from "./commands/auth.ts";
import { runFolder } from "./commands/folder.ts";
import { runInstall } from "./commands/install.ts";
import { runJava } from "./commands/java.ts";
import { runLaunch } from "./commands/launch.ts";
import { runMod } from "./commands/mod.ts";
import { runModpack } from "./commands/modpack.ts";
import { runVersion } from "./commands/version.ts";
import {
    optionalInteger,
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
    version: { type: "boolean", short: "V", summary: "显示版本号" },
};

export const COMMANDS: CommandTable = {
    launch: {
        summary: "启动游戏",
        usage: "launch [version] [--account <name>] [--folder <id>] [--dry-run]",
        options: {
            account: { type: "string", value: "<name>", summary: "使用指定账户" },
            folder: { type: "string", value: "<id>", summary: "指定游戏文件夹" },
            "dry-run": { type: "boolean", summary: "只打印启动命令，不真的启动" },
        },
        positionals: { names: ["version"], required: 0 },
        toCommand: (values, positionals) => ({
            name: "launch",
            version: optionalPositional(positionals, 0, "version"),
            account: optionalString(values, "account"),
            folder: optionalString(values, "folder"),
            dryRun: values["dry-run"] === true,
        }),
        run: runLaunch,
    },

    install: {
        summary: "安装指定版本",
        usage: "install <version> [--name <名字>] [--loader <名字@版本>] [--folder <id>] [--no-assets]",
        options: {
            name: {
                type: "string",
                value: "<名字>",
                summary: "版本显示名，省略时按版本与加载器推导",
            },
            loader: {
                type: "string",
                value: "<名字@版本>",
                summary: "同时装模组加载器，目前只有 fabric",
            },
            folder: { type: "string", value: "<id>", summary: "指定游戏文件夹" },
            "no-assets": { type: "boolean", summary: "跳过资源对象，只装游戏本体" },
        },
        positionals: { names: ["version"], required: 1 },
        toCommand: (values, positionals) => ({
            name: "install",
            version: requirePositional(positionals, 0, "version"),
            displayName: optionalString(values, "name"),
            loader: optionalString(values, "loader"),
            folder: optionalString(values, "folder"),
            assets: values["no-assets"] !== true,
        }),
        run: runInstall,
    },

    auth: {
        summary: "账户管理",
        usage: "auth <login|logout|list> [username] [--type <name>] [--client-id <id>]",
        options: {
            type: {
                type: "string",
                value: "<name>",
                summary: "账号类型：offline（离线，默认）/ microsoft（微软）",
            },
            "client-id": {
                type: "string",
                value: "<id>",
                summary: "微软登录用的 Azure 应用 id，也可用 BLOOMERY_CLIENT_ID",
            },
        },
        positionals: { names: ["action", "username"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["login", "logout", "list"] as const,
                "action",
            );
            // 游戏名：list 不用，logout 必给，登录只有离线要（微软的游戏名从账号里取）
            const username =
                action === "logout"
                    ? requirePositional(positionals, 1, "username")
                    : optionalPositional(positionals, 1, "username");
            return {
                name: "auth",
                action,
                username,
                type: optionalString(values, "type"),
                clientId: optionalString(values, "client-id"),
            };
        },
        run: runAuth,
    },

    mod: {
        summary: "MOD 检索与安装",
        usage: "mod <search|install> <query> [--version <id>] [--folder <id>] [--dry-run] [--deps|--no-deps] [--limit <n>]",
        options: {
            version: {
                type: "string",
                value: "<id>",
                summary: "装到哪个实例，省略按上次启动的",
            },
            folder: { type: "string", value: "<id>", summary: "游戏文件夹" },
            "dry-run": { type: "boolean", summary: "只算不装" },
            deps: { type: "boolean", summary: "连必需依赖一起装" },
            "no-deps": { type: "boolean", summary: "只装这一个，不动依赖" },
            limit: { type: "string", value: "<n>", summary: "搜索结果条数，默认 10" },
        },
        positionals: { names: ["action", "query"], required: 2 },
        toCommand: (values, positionals) => ({
            name: "mod",
            action: requireChoice(
                requirePositional(positionals, 0, "action"),
                ["search", "install"] as const,
                "action",
            ),
            query: requirePositional(positionals, 1, "query"),
            version: optionalString(values, "version"),
            folder: optionalString(values, "folder"),
            dryRun: values["dry-run"] === true,
            deps: values["deps"] === true ? true : values["no-deps"] === true ? false : undefined,
            limit: optionalInteger(values, "limit"),
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

    folder: {
        summary: "游戏文件夹管理",
        usage: "folder <add|remove|list|scan|select> [path|id]",
        options: {},
        positionals: { names: ["action", "target"], required: 1 },
        toCommand: (_values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["add", "remove", "list", "scan", "select"] as const,
                "action",
            );
            if (action === "add") {
                return {
                    name: "folder",
                    action,
                    target: requirePositional(positionals, 1, "path"),
                };
            }
            if (action === "remove" || action === "select") {
                return { name: "folder", action, target: requirePositional(positionals, 1, "id") };
            }
            return { name: "folder", action, target: optionalPositional(positionals, 1, "id") };
        },
        run: runFolder,
    },

    version: {
        summary: "列出与查看版本",
        usage: "version <list|info> [id] [--folder <id>]",
        options: {
            folder: { type: "string", value: "<id>", summary: "指定游戏文件夹" },
        },
        positionals: { names: ["action", "id"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["list", "info"] as const,
                "action",
            );
            const id =
                action === "info"
                    ? requirePositional(positionals, 1, "id")
                    : optionalPositional(positionals, 1, "id");
            return { name: "version", action, id, folder: optionalString(values, "folder") };
        },
        run: runVersion,
    },

    java: {
        summary: "Java 运行时管理",
        usage: "java <list|scan|add|remove|which> [path] [--major <版本>]",
        options: {
            major: { type: "string", value: "<版本>", summary: "限定 Java 主版本" },
        },
        positionals: { names: ["action", "target"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["list", "scan", "add", "remove", "which"] as const,
                "action",
            );
            const target =
                action === "add" || action === "remove"
                    ? requirePositional(positionals, 1, "path")
                    : optionalPositional(positionals, 1, "target");
            return { name: "java", action, target, major: optionalInteger(values, "major") };
        },
        run: runJava,
    },
};

export const CLI_SPEC: CliSpec = { globals: GLOBAL_OPTIONS, commands: COMMANDS };
