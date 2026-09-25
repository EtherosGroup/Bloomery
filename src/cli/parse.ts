/*
 * 入参解析：argv → 命令对象
 *
 * 本文件拥有 CLI 的数据形状：Command、Context、命令表与选项声明的类型
 * 两级 strict 解析：第一级只吃全局旗标，第二级吃命令自己的选项
 * 边界用 tokens 里第一个位置参数的下标定位，Node 的 parseArgs 没有 stopAtPositional
 * 全局旗标必须写在命令名之前，写在后面会被命令层的 strict 解析当成未知选项
 */

import { parseArgs } from "node:util";
import type { ParseArgsOptionsConfig } from "node:util";

import { AppError } from "../error/index.ts";
import type { LogLevel } from "../output/index.ts";

/* ---------- 命令 ---------- */

export interface LaunchCommand {
    readonly name: "launch";
    /** 省略表示用默认实例 */
    readonly version?: string;
    readonly account?: string;
}

export interface InstallCommand {
    readonly name: "install";
    readonly version: string;
    readonly loader?: string;
}

export interface AuthCommand {
    readonly name: "auth";
    readonly action: "login" | "logout" | "list";
}

export interface ModCommand {
    readonly name: "mod";
    readonly action: "search" | "install";
    readonly query: string;
}

export interface ModpackCommand {
    readonly name: "modpack";
    readonly file: string;
}

export type Command = LaunchCommand | InstallCommand | AuthCommand | ModCommand | ModpackCommand;

export type CommandName = Command["name"];

/* ---------- 选项声明 ---------- */

export interface OptionDecl {
    readonly type: "boolean" | "string";
    readonly short?: string;
    readonly multiple?: boolean;
    /** 帮助里的取值占位，布尔选项省略 */
    readonly value?: string;
    readonly summary: string;
}

export type OptionDecls = Readonly<Record<string, OptionDecl>>;

export type ParsedValues = Readonly<
    Record<string, string | boolean | (string | boolean)[] | undefined>
>;

export interface Parsed {
    readonly values: ParsedValues;
    readonly positionals: readonly string[];
}

/* ---------- 命令表 ---------- */

export interface PositionalSpec {
    /** 位置参数的显示名，长度即最大个数 */
    readonly names: readonly string[];
    /** 必填个数 */
    readonly required: number;
}

export interface CommandSpec<C extends Command> {
    readonly summary: string;
    /** 帮助与错误提示里的用法串，命令名之后的部分 */
    readonly usage: string;
    readonly options: OptionDecls;
    readonly positionals: PositionalSpec;
    readonly toCommand: (values: ParsedValues, positionals: readonly string[]) => C;
    readonly run: (command: C, ctx: Context) => Promise<void>;
}

export type CommandTable = {
    readonly [K in CommandName]: CommandSpec<Extract<Command, { name: K }>>;
};

export interface CliSpec {
    readonly globals: OptionDecls;
    readonly commands: CommandTable;
}

/** 传给命令处理器的只读上下文，全局旗标的解析结果 */
export interface Context {
    readonly json: boolean;
    readonly home?: string;
}

export interface GlobalOptions {
    readonly level: LogLevel;
    readonly json: boolean;
    readonly home?: string;
    readonly help: boolean;
}

export type ParsedCli =
    | { readonly kind: "command"; readonly globals: GlobalOptions; readonly command: Command }
    /** 没给命令名，或者给了 --help；name 有值表示要看某个命令的帮助 */
    | { readonly kind: "help"; readonly globals: GlobalOptions; readonly name?: CommandName };

/* ---------- 入口 ---------- */

export function parse(argv: readonly string[], spec: CliSpec): ParsedCli {
    const args = [...argv];
    const index = commandIndex(args, spec.globals);
    const global = strictParse(args.slice(0, index), spec.globals, spec.globals);

    const globals: GlobalOptions = {
        level: levelOf(global.values),
        json: global.values["json"] === true,
        home: optionalString(global.values, "home"),
        help: global.values["help"] === true,
    };

    const name = args[index];
    if (name === undefined) {
        return { kind: "help", globals };
    }
    if (!Object.hasOwn(spec.commands, name)) {
        throw new AppError("cli", "UnknownCommand", { context: { detail: name } });
    }

    const commandName = name as CommandName;
    const command = spec.commands[commandName];
    // help 的声明从全局表里取，命令表不必各自再写一遍
    const helpDecl = spec.globals["help"];
    const decls = helpDecl === undefined ? command.options : { ...command.options, help: helpDecl };
    const parsed = strictParse(args.slice(index + 1), decls, spec.globals);

    if (globals.help || parsed.values["help"] === true) {
        return { kind: "help", globals, name: commandName };
    }

    const count = parsed.positionals.length;
    if (count < command.positionals.required) {
        throw usage(`缺少参数 <${command.positionals.names[count] ?? "参数"}>`);
    }
    if (count > command.positionals.names.length) {
        throw usage(`多余的参数 ${parsed.positionals[command.positionals.names.length] ?? ""}`);
    }

    return {
        kind: "command",
        globals,
        command: command.toCommand(parsed.values, parsed.positionals),
    };
}

/* ---------- 校验工具，供命令表的 toCommand 使用 ---------- */

export function optionalString(values: ParsedValues, key: string): string | undefined {
    const value = values[key];
    if (value === undefined) {
        return undefined;
    }
    if (typeof value !== "string" || value === "") {
        throw usage(`选项 --${key} 缺少取值`);
    }
    return value;
}

export function requirePositional(
    positionals: readonly string[],
    index: number,
    name: string,
): string {
    const value = positionals[index];
    if (value === undefined) {
        throw usage(`缺少参数 <${name}>`);
    }
    return value;
}

export function optionalPositional(
    positionals: readonly string[],
    index: number,
    name: string,
): string | undefined {
    const value = positionals[index];
    if (value === undefined) {
        return undefined;
    }
    if (positionals.length > index + 1) {
        throw usage(`多余的参数 ${positionals[index + 1] ?? ""}`);
    }
    return value;
}

export function requireChoice<T extends string>(
    value: string,
    allowed: readonly T[],
    name: string,
): T {
    if (!allowed.includes(value as T)) {
        throw usage(`${name} 只能是 ${allowed.join(" / ")}`);
    }
    return value as T;
}

/* ---------- 内部 ---------- */

// 第一个位置参数的下标即命令边界
function commandIndex(args: readonly string[], globals: OptionDecls): number {
    try {
        const { tokens } = parseArgs({
            args,
            options: toParseOptions(globals),
            allowPositionals: true,
            strict: false,
            tokens: true,
        });
        return tokens.find((token) => token.kind === "positional")?.index ?? args.length;
    } catch (error) {
        throw usage(optionDetail(error, globals));
    }
}

function strictParse(args: readonly string[], decls: OptionDecls, globals: OptionDecls): Parsed {
    try {
        const { values, positionals } = parseArgs({
            args,
            options: toParseOptions(decls),
            allowPositionals: true,
            strict: true,
        });
        return { values, positionals };
    } catch (error) {
        throw usage(optionDetail(error, globals));
    }
}

// parseArgs 的报错是英文，只翻译未知选项这一类；命中全局选项时提示位置写错了
function optionDetail(error: unknown, globals: OptionDecls): string {
    const message = messageOf(error);
    const matched = /Unknown option '(--?[\w-]+)'/.exec(message);
    if (matched === null) {
        return message;
    }
    const flag = matched[1] ?? "";
    if (globals[flag.replace(/^--?/, "")] !== undefined) {
        return `全局选项 ${flag} 要写在命令名之前`;
    }
    return `未知选项 ${flag}`;
}

function toParseOptions(decls: OptionDecls): ParseArgsOptionsConfig {
    const options: ParseArgsOptionsConfig = {};
    for (const [name, decl] of Object.entries(decls)) {
        options[name] = {
            type: decl.type,
            ...(decl.short === undefined ? {} : { short: decl.short }),
            ...(decl.multiple === undefined ? {} : { multiple: decl.multiple }),
        };
    }
    return options;
}

// quiet 与 verbose 同时给时 quiet 优先
function levelOf(values: ParsedValues): LogLevel {
    if (values["quiet"] === true) {
        return "Warning";
    }
    if (values["verbose"] === true) {
        return "Debug";
    }
    return "Info";
}

function usage(detail: string): AppError {
    return new AppError("cli", "UsageError", { context: { detail } });
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
