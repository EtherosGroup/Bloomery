/**
 * 启动命令拼装
 *
 * 1.13 起用 arguments 数组，1.12.2 及以前用 minecraftArguments 字符串
 * 两边的条件项都走 dependency/rules 的同一套过滤
 * @author IsCibocaz
 * @since 1.0.0
 */

import { delimiter } from "node:path";

import type { Memory } from "../config/types.ts";
import { allows, type RuleContext } from "../dependency/rules.ts";
import type { ArgumentEntry, Descriptor } from "../version/descriptor.ts";

export interface ArgumentContext {
    readonly versionName: string;
    readonly versionType: string;
    readonly gameDirectory: string;
    readonly assetsRoot: string;
    readonly assetIndex: string;
    readonly nativesDirectory: string;
    readonly librariesRoot: string;
    readonly classpath: string;
    readonly userName: string;
    readonly uuid: string;
    readonly accessToken: string;
    /** 微软账户的 XUID，没有给空串 */
    readonly xuid: string;
    /** 启动器自己的客户端标识，只用于遥测，给空串即可 */
    readonly clientId: string;
    readonly userType: string;
    readonly launcherName: string;
    readonly launcherVersion: string;
    readonly width: number;
    readonly height: number;
    readonly rules: RuleContext;
}

export function buildJvmArguments(
    descriptor: Descriptor,
    context: ArgumentContext,
    memory: Memory,
    extra: readonly string[],
): string[] {
    const args = [`-Xms${memory.minMb}M`, `-Xmx${memory.maxMb}M`];

    if (descriptor.arguments.jvm.length > 0) {
        args.push(...expandArguments(descriptor.arguments.jvm, context));
    } else {
        // 1.12.2 及以前没有 arguments，classpath 与 natives 得自己补
        args.push(`-Djava.library.path=${context.nativesDirectory}`, "-cp", context.classpath);
    }

    args.push(...extra);
    return args;
}

export function buildGameArguments(
    descriptor: Descriptor,
    context: ArgumentContext,
    extra: readonly string[],
): string[] {
    if (descriptor.arguments.game.length > 0) {
        return [...expandArguments(descriptor.arguments.game, context), ...extra];
    }

    const legacy = descriptor.minecraftArguments;
    if (legacy !== null) {
        const parts = legacy
            .split(/\s+/)
            .filter((part) => part !== "")
            .map((part) => substitute(part, context));
        return [...parts, ...extra];
    }
    return [...extra];
}

export function expandArguments(
    entries: readonly ArgumentEntry[],
    context: ArgumentContext,
): string[] {
    const args: string[] = [];
    for (const entry of entries) {
        if (typeof entry === "string") {
            args.push(substitute(entry, context));
            continue;
        }
        if (!allows(entry.rules, context.rules)) {
            continue;
        }
        const values = typeof entry.value === "string" ? [entry.value] : entry.value;
        for (const value of values) {
            args.push(substitute(value, context));
        }
    }
    return args;
}

// 认不出的占位符原样留下，交给调用方从参数里发现
export function substitute(text: string, context: ArgumentContext): string {
    const table = placeholders(context);
    return text.replace(/\$\{([A-Za-z_]+)\}/g, (whole, key: string) => table[key] ?? whole);
}

function placeholders(context: ArgumentContext): Record<string, string> {
    return {
        auth_player_name: context.userName,
        version_name: context.versionName,
        game_directory: context.gameDirectory,
        assets_root: context.assetsRoot,
        game_assets: context.assetsRoot,
        assets_index_name: context.assetIndex,
        auth_uuid: context.uuid,
        auth_access_token: context.accessToken,
        auth_session: context.accessToken,
        auth_xuid: context.xuid,
        clientid: context.clientId,
        user_type: context.userType,
        version_type: context.versionType,
        natives_directory: context.nativesDirectory,
        launcher_name: context.launcherName,
        launcher_version: context.launcherVersion,
        classpath: context.classpath,
        classpath_separator: delimiter,
        library_directory: context.librariesRoot,
        resolution_width: String(context.width),
        resolution_height: String(context.height),
        profiles_folder: context.gameDirectory,
        user_properties: "{}",
    };
}
