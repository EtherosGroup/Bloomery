/**
 * 系统名与架构到 Minecraft 的映射
 *
 * 版本 json 的 rules 用 JVM 属性里的写法（amd64、x86_64、aarch64），与 Node 的 process.arch 不同名
 * natives 分类名里的 macOS 写作 macos，而 os.name 写作 osx
 * @author IsCibocaz
 * @since 1.0.0
 */

import { arch as nodeArch, release } from "node:os";

import { platform } from "./os.ts";

export type OsArch = "x64" | "x86" | "arm64" | "arm";

// 版本 json 里 os.name 的取值
export function osName(): string {
    switch (platform) {
        case "Windows":
            return "windows";
        case "macOS":
            return "osx";
        default:
            return "linux";
    }
}

export function osVersion(): string {
    return release();
}

export function osArch(): OsArch | null {
    switch (nodeArch()) {
        case "x64":
            return "x64";
        case "ia32":
            return "x86";
        case "arm64":
            return "arm64";
        case "arm":
            return "arm";
        default:
            return null;
    }
}

const ALIASES: Record<OsArch, readonly string[]> = {
    x64: ["amd64", "x8664", "x64", "64"],
    x86: ["x86", "i386", "i486", "i586", "i686", "32"],
    arm64: ["aarch64", "arm64", "arm64e"],
    arm: ["arm", "armv6l", "armv7l"],
};

// 这个 token 是不是架构：认得出的才按架构筛，patch 这类不是架构的段要放行
export function isArchToken(value: string): boolean {
    const wanted = normalizeArch(value);
    return Object.values(ALIASES).some((aliases) => aliases.includes(wanted));
}

// 旧版 natives 映射里的 ${arch}：官方启动器填 JVM 位数，认不出架构时按 64 位算
export function archBitness(arch: OsArch | null): "32" | "64" {
    return arch === "x86" || arch === "arm" ? "32" : "64";
}

// rules 里的 os.arch 用 JVM 属性写法，同一个架构有多个别名
// netty 的分类名把 x86_64 写成 x86_64、aarch64 写成 aarch_64，下划线先去掉再比
export function archMatches(ruleArch: string, actual: OsArch | null): boolean {
    if (actual === null) {
        return false;
    }
    const wanted = normalizeArch(ruleArch);
    return ALIASES[actual].some((alias) => alias === wanted);
}

export function normalizeArch(value: string): string {
    return value.trim().toLowerCase().replace(/_/g, "");
}
