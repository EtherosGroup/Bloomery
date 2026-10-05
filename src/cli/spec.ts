/**
 * 命令表：命令名、选项、位置参数、帮助文案、处理器
 *
 * 唯一的命令清单，帮助文案与两级解析都从这里取
 * @author IsCibocaz
 * @since 1.0.0
 */

import { runAuth } from "./commands/auth.ts";
import { runConfig } from "./commands/config.ts";
import { runStatus } from "./commands/status.ts";
import { runDownload } from "./commands/download.ts";
import { runFolder } from "./commands/folder.ts";
import { runInstall } from "./commands/install.ts";
import { runJava } from "./commands/java.ts";
import { runLaunch } from "./commands/launch.ts";
import { runMod } from "./commands/mod.ts";
import { runModpack } from "./commands/modpack.ts";
import { runVersion } from "./commands/version.ts";
import { runMirror } from "./commands/mirror.ts";
import { runView } from "./commands/view.ts";
import { AppError } from "../error/index.ts";
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
    progress: {
        type: "string",
        value: "<style>",
        summary: "进度输出：bar / plain / off / ndjson（ndjson 走 stderr）",
    },
    json: { type: "boolean", summary: "以 JSON 输出结果" },
    home: { type: "string", value: "<dir>", summary: "指定数据目录" },
    help: { type: "boolean", short: "h", summary: "显示帮助" },
    version: { type: "boolean", short: "V", summary: "显示版本号" },
};

export const COMMANDS: CommandTable = {
    launch: {
        summary: "启动游戏",
        usage: "launch [version] [--account <name>] [--folder <id>] [--repair] [--dry-run] [--memory <mb>] [--wait-for-exit | --detach]",
        options: {
            account: { type: "string", value: "<name>", summary: "使用指定账户" },
            folder: { type: "string", value: "<id>", summary: "指定游戏文件夹" },
            repair: { type: "boolean", summary: "补全缺失文件后退出，不启动游戏" },
            "dry-run": { type: "boolean", summary: "只打印启动命令，不真的启动" },
            memory: { type: "string", value: "<mb>", summary: "本次启动的内存上限，不写进配置" },
            "wait-for-exit": { type: "boolean", summary: "等游戏退出，退出码原样带出去" },
            detach: { type: "boolean", summary: "起完就返回，不等游戏退出" },
        },
        positionals: { names: ["version"], required: 0 },
        toCommand: (values, positionals) => ({
            name: "launch",
            version: optionalPositional(positionals, 0, "version"),
            account: optionalString(values, "account"),
            folder: optionalString(values, "folder"),
            dryRun: values["dry-run"] === true,
            repair: values["repair"] === true,
            memory: optionalInteger(values, "memory"),
            waitForExit: values["wait-for-exit"] === true,
            detach: values["detach"] === true,
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
                summary: "同时装模组加载器：fabric / forge / neoforge / quilt",
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
        usage: "auth <login|logout|list|use> [username] [--type <name>] [--client-id <id>]",
        options: {
            type: {
                type: "string",
                value: "<name>",
                summary:
                    "账号类型：offline（离线）/ microsoft（微软）；login 省略按离线，logout 与 use 省略按游戏名",
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
                ["login", "logout", "list", "use"] as const,
                "action",
            );
            // 游戏名：list 不用，logout 与 use 必给，登录只有离线要（微软的游戏名从账号里取）
            const username =
                action === "logout" || action === "use"
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
        usage: "mod <search|install> <query> [--version <id>] [--folder <id>] [--dry-run] [--deps|--no-deps] [--async] [--limit <n>]",
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
            async: { type: "boolean", summary: "入队并拉起后台 worker，立刻返回" },
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
            async: values["async"] === true,
            limit: optionalInteger(values, "limit"),
        }),
        run: runMod,
    },

    download: {
        summary: "下载队列",
        usage: "download <info|run|cancel|retry|clear> [id]",
        options: {},
        positionals: { names: ["action", "id"], required: 1 },
        toCommand: (_values, positionals) => ({
            name: "download",
            action: requireChoice(
                requirePositional(positionals, 0, "action"),
                ["info", "run", "cancel", "retry", "clear"] as const,
                "action",
            ),
            id: optionalPositional(positionals, 1, "id"),
        }),
        run: runDownload,
    },

    mirror: {
        summary: "查看与切换下载源",
        usage: "mirror <list|use|update> [name] [--url <地址>] [--from <地址>]",
        options: {
            url: { type: "string", value: "<地址>", summary: "custom 的根地址" },
            from: { type: "string", value: "<地址>", summary: "镜像清单地址，省略用上次的" },
        },
        positionals: { names: ["action", "name"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["list", "use", "update"] as const,
                "action",
            );
            return {
                name: "mirror",
                action,
                preset:
                    action === "use"
                        ? requirePositional(positionals, 1, "name")
                        : optionalPositional(positionals, 1, "name"),
                url: optionalString(values, "url"),
                from: optionalString(values, "from"),
            };
        },
        run: runMirror,
    },

    view: {
        summary: "查看加载器可用的版本",
        usage: "view <loader|game> [name] [--game <version>] [--games] [--page <n>] [--type <release|beta|alpha>]",
        options: {
            page: { type: "string", value: "<n>", summary: "页码，从 1 开始，每页 20 条" },
            type: {
                type: "string",
                value: "<name>",
                summary: "只看某个发布通道：release / beta / alpha",
            },
            game: {
                type: "string",
                value: "<version>",
                summary: "只看这个游戏版本上可用的加载器版本",
            },
            games: { type: "boolean", summary: "改列这个加载器支持的游戏版本" },
        },
        positionals: { names: ["action", "name"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["loader", "game"] as const,
                "action",
            );
            // 第二个位置参数按 action 解读：loader 是加载器名，game 是游戏版本
            const target = optionalPositional(positionals, 1, "name");
            return {
                name: "view",
                action,
                loader: action === "loader" ? target : undefined,
                game: action === "game" ? target : optionalString(values, "game"),
                games: values["games"] === true,
                page: optionalInteger(values, "page"),
                type: optionalString(values, "type"),
            };
        },
        run: runView,
    },

    modpack: {
        summary: "导入整合包（.mrpack）",
        usage: "modpack <file> [--name <name>] [--folder <id>] [--dry-run] [--no-assets]",
        options: {
            name: { type: "string", value: "<name>", summary: "实例名，省略按包名推" },
            folder: { type: "string", value: "<id>", summary: "游戏文件夹" },
            "dry-run": { type: "boolean", summary: "只算不导入" },
            "no-assets": { type: "boolean", summary: "跳过资源对象，只装游戏本体" },
        },
        positionals: { names: ["file"], required: 1 },
        toCommand: (values, positionals) => ({
            name: "modpack",
            file: requirePositional(positionals, 0, "file"),
            displayName: optionalString(values, "name"),
            folder: optionalString(values, "folder"),
            dryRun: values["dry-run"] === true,
            noAssets: values["no-assets"] === true,
        }),
        run: runModpack,
    },

    folder: {
        summary: "游戏文件夹管理",
        usage: "folder <add|remove|list|scan|select> [path|id]",
        options: {
            "dry-run": { type: "boolean", summary: "add 只校验不落盘" },
            "no-select": { type: "boolean", summary: "add 后不设为当前文件夹" },
        },
        positionals: { names: ["action", "target"], required: 1 },
        toCommand: (values, positionals) => {
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
                    dryRun: values["dry-run"] === true,
                    noSelect: values["no-select"] === true,
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
        summary: "列出、查看、选中与改名版本",
        usage: "version <list|info|select|rename> [id] [新名字] [--folder <id>] [--dry-run]",
        options: {
            folder: { type: "string", value: "<id>", summary: "指定游戏文件夹" },
            "dry-run": { type: "boolean", summary: "rename 只算不改" },
        },
        positionals: { names: ["action", "id", "新名字"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["list", "info", "select", "rename"] as const,
                "action",
            );
            if (action === "rename") {
                return {
                    name: "version",
                    action,
                    id: requirePositional(positionals, 1, "id"),
                    renameTo: requirePositional(positionals, 2, "新名字"),
                    folder: optionalString(values, "folder"),
                    dryRun: values["dry-run"] === true,
                };
            }
            const id =
                action === "info" || action === "select"
                    ? requirePositional(positionals, 1, "id")
                    : optionalPositional(positionals, 1, "id");
            return { name: "version", action, id, folder: optionalString(values, "folder") };
        },
        run: runVersion,
    },

    java: {
        summary: "Java 运行时管理",
        usage: "java <list|scan|add|remove|which|install> [path|版本] [--major <版本>] [--image <jre|jdk>] [--path <目录>] [--arch <架构>] [--provider <adoptium|mojang>] [--dry-run] [--no-register] [--force]",
        options: {
            major: { type: "string", value: "<版本>", summary: "限定 Java 主版本" },
            image: { type: "string", value: "<jre|jdk>", summary: "install 要哪种包，默认 jre" },
            path: { type: "string", value: "<目录>", summary: "install 的安装位置" },
            arch: { type: "string", value: "<x64|arm64>", summary: "install 的目标架构，默认本机" },
            provider: {
                type: "string",
                value: "<来源>",
                summary: "install 的来源：adoptium / mojang，默认 adoptium",
            },
            "dry-run": { type: "boolean", summary: "只查地址，不下载" },
            "no-register": { type: "boolean", summary: "装完不写进 java 清单" },
            force: { type: "boolean", summary: "目标已存在时也重装" },
        },
        positionals: { names: ["action", "target"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["list", "scan", "add", "remove", "which", "install"] as const,
                "action",
            );
            const target =
                action === "add" || action === "remove"
                    ? requirePositional(positionals, 1, "path")
                    : optionalPositional(positionals, 1, "target");
            const provider = optionalString(values, "provider");
            return {
                name: "java",
                action,
                target,
                major: optionalInteger(values, "major"),
                image:
                    values["image"] === "jdk"
                        ? "jdk"
                        : values["image"] === "jre"
                          ? "jre"
                          : undefined,
                path: optionalString(values, "path"),
                arch: optionalString(values, "arch"),
                provider:
                    provider === undefined
                        ? undefined
                        : requireChoice(provider, ["adoptium", "mojang"] as const, "provider"),
                dryRun: values["dry-run"] === true,
                noRegister: values["no-register"] === true,
                force: values["force"] === true,
            };
        },
        run: runJava,
    },
    config: {
        summary: "读写配置",
        usage: "config <get|set|unset> [键] [值] [--folder <id>] [--instance <id>] [--string]",
        options: {
            string: { type: "boolean", summary: "set 时把值当普通字符串" },
            folder: { type: "string", value: "<id>", summary: "作用域：文件夹 id，可含点号" },
            instance: {
                type: "string",
                value: "<id>",
                summary: "作用域：实例 id，可含点号，要配 --folder",
            },
        },
        positionals: { names: ["action", "key", "value"], required: 1 },
        toCommand: (values, positionals) => {
            const action = requireChoice(
                requirePositional(positionals, 0, "action"),
                ["get", "set", "unset"] as const,
                "action",
            );
            if (positionals.length > 3) {
                throw new AppError("cli", "UsageError", {
                    context: { detail: `多余的参数 ${positionals[3] ?? ""}` },
                });
            }
            return {
                name: "config",
                action,
                key: positionals[1],
                value: positionals[2],
                asString: values["string"] === true,
                folder: optionalString(values, "folder"),
                instance: optionalString(values, "instance"),
            };
        },
        run: runConfig,
    },

    status: {
        summary: "环境快照",
        usage: "status",
        options: {},
        positionals: { names: [], required: 0 },
        toCommand: () => ({ name: "status" }),
        run: runStatus,
    },
};

export const CLI_SPEC: CliSpec = { globals: GLOBAL_OPTIONS, commands: COMMANDS };
