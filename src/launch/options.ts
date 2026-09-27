/**
 * 启动取值的来源
 *
 * 三层：实例 → 文件夹 → 全局；useGlobalSettings 里对应开关为 true 时忽略实例自己的值
 * memory 与 window 是覆盖，jvmArgs 与 gameArgs 是追加
 * @author IsCibocaz
 * @since 1.0.0
 */

import type { Folder, Instance, Memory, MemoryPatch, Setting, Window } from "../config/types.ts";

export interface LaunchOptions {
    readonly javaPath: string | null;
    readonly memory: Memory;
    readonly window: Window;
    readonly jvmArgs: readonly string[];
    readonly gameArgs: readonly string[];
}

export function launchOptionsOf(
    setting: Setting,
    folder: Folder,
    instance: Instance | undefined,
): LaunchOptions {
    const global = setting.launch;
    const switches = instance?.useGlobalSettings ?? {};

    return {
        javaPath: own(switches.java, instance?.java) ?? folder.java ?? null,
        memory: mergeMemory(global.memory, folder.memory, own(switches.memory, instance?.memory)),
        window: own(switches.window, instance?.window) ?? global.window,
        jvmArgs: [...global.jvmArgs, ...(own(switches.jvmArgs, instance?.jvmArgs) ?? [])],
        gameArgs: [...global.gameArgs, ...(own(switches.gameArgs, instance?.gameArgs) ?? [])],
    };
}

// 开关为 true 就丢掉实例自己的值，改用上层
function own<T>(enabled: boolean | undefined, value: T | null | undefined): T | undefined {
    return enabled === true ? undefined : (value ?? undefined);
}

function mergeMemory(
    global: Memory,
    folder: MemoryPatch | null | undefined,
    instance: MemoryPatch | null | undefined,
): Memory {
    return {
        minMb: instance?.minMb ?? folder?.minMb ?? global.minMb,
        maxMb: instance?.maxMb ?? folder?.maxMb ?? global.maxMb,
    };
}
