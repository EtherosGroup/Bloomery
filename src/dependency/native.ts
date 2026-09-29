/**
 * natives 解压
 *
 * 两种写法都要认：
 *   旧格式 库带 natives 映射，键是 os.name，值是分类名
 *   新格式 库名第四段本身就是 natives-<平台> 分类名
 * 解压到版本目录下的 natives/，先清掉这一层，换版本后不会残留旧 dll
 * @author IsCibocaz
 * @since 1.0.0
 */

import { mkdir, rm } from "node:fs/promises";
import { sep } from "node:path";

import { pathExists } from "../infra/fs.ts";
import { extractZip } from "../infra/zip.ts";
import { logger } from "../output/index.ts";
import { archBitness } from "../platform/index.ts";
import type { ArgumentEntry, Library } from "../version/descriptor.ts";
import { classifierMatches, libraryFile, parseCoordinate } from "./library.ts";
import { allows, type RuleContext } from "./rules.ts";

const log = logger("dependency");

export interface NativeJar {
    readonly library: string;
    readonly jar: string;
    readonly classifier: string;
    readonly exclude: readonly string[];
}

export interface NativeSelection {
    readonly jars: readonly NativeJar[];
    readonly missing: readonly string[];
}

export interface NativeInput {
    readonly libraries: readonly Library[];
    readonly context: RuleContext;
    readonly librariesRoot: string;
}

// native 库该放哪：26.x 起 natives 分成几个目录，dll 不能平铺在一层里
export interface NativesLayout {
    /** java.library.path 指向的目录，dll 解到这里按名字才加载得到 */
    readonly libraryPath: string;
    /** 另外几个解压目标目录（JNA、LWJGL、netty 各自往里解压），先建出来 */
    readonly extraDirectories: readonly string[];
    /** natives jar 是否要挂进 classpath：新版靠 LWJGL 自己从 jar 里解压 */
    readonly classpath: boolean;
}

// 从版本 json 的 jvm 参数判定 natives 布局：
// 1.20.6 是 -Djava.library.path=${natives_directory}，26.2 变成 ${natives_directory}/java 外加三个解压目录
// 指向 natives 目录之外的写法一律按老布局处理
export function nativesLayout(
    jvm: readonly ArgumentEntry[],
    nativesDirectory: string,
): NativesLayout {
    const property = (name: string): string | undefined => {
        const prefix = `-D${name}=`;
        for (const text of flatten(jvm)) {
            if (text.startsWith(prefix)) {
                return text.slice(prefix.length).replace("${natives_directory}", nativesDirectory);
            }
        }
        return undefined;
    };

    const wanted = property("java.library.path");
    const libraryPath = inside(wanted, nativesDirectory) ? wanted : nativesDirectory;
    const extraDirectories: string[] = [];
    for (const name of [
        "jna.tmpdir",
        "org.lwjgl.system.SharedLibraryExtractPath",
        "io.netty.native.workdir",
    ]) {
        const value = property(name);
        if (inside(value, nativesDirectory) && value !== libraryPath) {
            extraDirectories.push(value);
        }
    }

    return {
        libraryPath,
        extraDirectories,
        classpath: libraryPath !== nativesDirectory || extraDirectories.length > 0,
    };
}

// 条件项也收：只看属性名对不对得上，不管 rules
function flatten(jvm: readonly ArgumentEntry[]): string[] {
    const out: string[] = [];
    for (const entry of jvm) {
        if (typeof entry === "string") {
            out.push(entry);
        } else if (typeof entry.value === "string") {
            out.push(entry.value);
        } else {
            out.push(...entry.value);
        }
    }
    return out;
}

// 只认 natives 目录本身或它下面的子目录
function inside(value: string | undefined, nativesDirectory: string): value is string {
    if (value === undefined) {
        return false;
    }
    return (
        value === nativesDirectory ||
        value.startsWith(`${nativesDirectory}${sep}`) ||
        value.startsWith(`${nativesDirectory}/`)
    );
}

export async function nativeJars(input: NativeInput): Promise<NativeSelection> {
    const jars: NativeJar[] = [];
    const missing: string[] = [];

    for (const library of input.libraries) {
        if (!allows(library.rules, input.context)) {
            continue;
        }
        const coordinate = parseCoordinate(library.name);
        if (coordinate === undefined) {
            continue;
        }

        const classifier = nativeClassifierOf(library, input.context);
        if (classifier === undefined) {
            continue;
        }

        const jar = libraryFile(input.librariesRoot, { ...coordinate, classifier });
        if (await pathExists(jar)) {
            jars.push({ library: library.name, jar, classifier, exclude: library.exclude });
        } else {
            missing.push(jar);
        }
    }

    return { jars, missing };
}

// 当前平台要用的 natives 分类名：
// 旧格式看库自带的 natives 映射，键是 os.name，值里可能有 ${arch}；新格式分类名就在库名第四段
// 分类名只在平台对得上、架构也对得上时才用：json 里 natives-windows 与 natives-windows-arm64 的 rules 完全一样
export function nativeClassifierOf(library: Library, context: RuleContext): string | undefined {
    const mapped: string | undefined = library.natives[context.osName];
    if (mapped !== undefined) {
        const classifier = mapped.replace("${arch}", archBitness(context.osArch));
        return classifierMatches(classifier, context) ? classifier : undefined;
    }
    const classifier = parseCoordinate(library.name)?.classifier;
    if (classifier?.startsWith("natives-") !== true) {
        return undefined;
    }
    return classifierMatches(classifier, context) ? classifier : undefined;
}

// 先清空目录再解压
export async function extractNatives(
    jars: readonly NativeJar[],
    directory: string,
): Promise<number> {
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });

    let written = 0;
    for (const native of jars) {
        const excludes = [...native.exclude, "META-INF/"];
        const count = await extractZip(native.jar, directory, {
            // DLL/SO 里带着目录层级，平铺出来 java.library.path 才找得到
            keep: (name) => excludes.every((prefix) => !name.startsWith(prefix)),
            flatten: true,
        });
        log.debug("%s 解出 %d 个文件", native.classifier, count);
        written += count;
    }
    return written;
}
