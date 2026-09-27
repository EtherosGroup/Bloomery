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

import { pathExists } from "../infra/fs.ts";
import { extractZip } from "../infra/zip.ts";
import { logger } from "../output/index.ts";
import type { Library } from "../version/descriptor.ts";
import { libraryFile, parseCoordinate } from "./library.ts";
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

        const mapped: string | undefined = library.natives[input.context.osName];
        const classifier =
            mapped ??
            (coordinate.classifier?.startsWith("natives") === true
                ? coordinate.classifier
                : undefined);
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
