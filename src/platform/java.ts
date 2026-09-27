/**
 * Java 安装位置的平台差异
 *
 * 各平台的安装根不同，根到可执行文件的相对路径也不同，两边都由 javaLayout 给出
 * @author IsCibocaz
 * @since 1.0.0
 */

import { join } from "node:path";

import { platform } from "./os.ts";
import { homeDirectory } from "./path.ts";

// 可执行文件名
export const JAVA_EXECUTABLE = platform === "Windows" ? "java.exe" : "java";
export const JAVAC_EXECUTABLE = platform === "Windows" ? "javac.exe" : "javac";

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
