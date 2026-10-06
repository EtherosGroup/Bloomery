/**
 * Java 安装位置的平台差异
 *
 * 各平台的安装根不同，根到可执行文件的相对路径也不同，两边都由 javaLayout 给出
 * @author IsCibocaz
 * @since 1.0.0
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { platform } from "./os.ts";
import { homeDirectory } from "./path.ts";

// 可执行文件名
export const JAVA_EXECUTABLE = platform === "Windows" ? "java.exe" : "java";
export const JAVAC_EXECUTABLE = platform === "Windows" ? "javac.exe" : "javac";

// java.exe 旁边的 javaw.exe：只换文件名后缀，不动分隔符
// 这里写死 Windows 的后缀，不用 JAVA_EXECUTABLE —— 那是随当前平台变的，换到 Linux 上这个函数就换了语义
// 入参不是 java.exe 时给 null（例如已经是 javaw.exe，或非 Windows 的 java）
export function javawPath(java: string): string | null {
    const suffix = "java.exe";
    if (!java.toLowerCase().endsWith(suffix)) {
        return null;
    }
    return `${java.slice(0, java.length - suffix.length)}javaw.exe`;
}

// 启动游戏用的可执行文件
// Windows 上 java.exe 是控制台子系统程序：父进程没有控制台（GUI 起的）时系统会新分配一个控制台窗口，
// 它出现在桌面上并抢前台，把游戏窗口盖在后面；javaw.exe 不申请控制台，原版启动器在 Windows 上用的是它
// 探测仍走 java.exe —— javaw 没有控制台，-XshowSettings 的输出拿不到
export function gameExecutable(java: string): string {
    if (platform !== "Windows") {
        return java;
    }
    const javaw = javawPath(java);
    return javaw !== null && existsSync(javaw) ? javaw : java;
}

export interface JavaLayout {
    /** 安装根，逐个看它的一级子目录 */
    readonly roots: readonly string[];
    /** 根到 java 可执行文件的相对路径，按顺序试 */
    readonly relative: readonly string[];
}

export function javaLayout(): JavaLayout {
    switch (platform) {
        case "Windows": {
            const roots: string[] = [];
            for (const key of ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"]) {
                const base = process.env[key];
                if (base === undefined || base === "") {
                    continue;
                }
                for (const vendor of [
                    "Java",
                    "Eclipse Adoptium",
                    "Microsoft",
                    "Zulu",
                    "BellSoft",
                ]) {
                    roots.push(join(base, vendor));
                }
            }
            return { roots, relative: [join("bin", "java.exe")] };
        }
        case "macOS":
            return {
                roots: [
                    "/Library/Java/JavaVirtualMachines",
                    join(homeDirectory(), "Library", "Java", "JavaVirtualMachines"),
                ],
                relative: [join("Contents", "Home", "bin", "java"), join("bin", "java")],
            };
        default:
            return {
                roots: [
                    "/usr/lib/jvm",
                    "/usr/java",
                    "/opt/java",
                    join(homeDirectory(), ".sdkman", "candidates", "java"),
                ],
                relative: [join("bin", "java")],
            };
    }
}
