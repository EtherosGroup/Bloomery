/**
 * classpath 拼装
 *
 * 按合并后的库顺序来，客户端 jar 放最后
 * @author IsCibocaz
 * @since 1.0.0
 */

import { pathExists } from "../infra/fs.ts";
import type { Library } from "../version/descriptor.ts";
import { classifierMatches, isClasspathLibrary, libraryFile, parseCoordinate } from "./library.ts";
import { allows, type RuleContext } from "./rules.ts";

export interface Classpath {
    readonly entries: readonly string[];
    /** 缺失的库，跳过并记一条警告 */
    readonly missing: readonly string[];
    readonly clientJar: string;
    /** 客户端 jar 不在就没必要起进程 */
    readonly clientJarPresent: boolean;
}

export interface ClasspathInput {
    readonly libraries: readonly Library[];
    readonly context: RuleContext;
    readonly librariesRoot: string;
    /** 客户端 jar：原版在 versions/<id>/<id>.jar，加载器版本指向父版本 */
    readonly clientJar: string;
    /** natives jar：26.x 起要挂进 classpath，LWJGL 自己从 jar 里解压到 SharedLibraryExtractPath */
    readonly natives?: readonly string[];
}

export async function classpathOf(input: ClasspathInput): Promise<Classpath> {
    const entries: string[] = [];
    const missing: string[] = [];

    for (const library of input.libraries) {
        if (!allows(library.rules, input.context) || !isClasspathLibrary(library)) {
            continue;
        }
        const coordinate = parseCoordinate(library.name);
        if (coordinate === undefined) {
            continue;
        }
        if (
            coordinate.classifier !== null &&
            !classifierMatches(coordinate.classifier, input.context)
        ) {
            continue;
        }
        const file = libraryFile(input.librariesRoot, coordinate);
        if (await pathExists(file)) {
            entries.push(file);
        } else {
            missing.push(file);
        }
    }

    for (const file of input.natives ?? []) {
        if (await pathExists(file)) {
            entries.push(file);
        } else {
            missing.push(file);
        }
    }

    const clientJarPresent = await pathExists(input.clientJar);
    if (clientJarPresent) {
        entries.push(input.clientJar);
    }

    return { entries, missing, clientJar: input.clientJar, clientJarPresent };
}
