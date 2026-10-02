/**
 * 官方安装器要用的 java
 *
 * 不能拿到哪个用哪个：default-java 可能比安装器支持的版本新太多（Forge 1.20.6 的安装器在 java 25 上会卡死，21 正常）
 * 所以把设置里登记的与自动探测到的都探一遍主版本，按目标版本挑
 * @author IsCibocaz
 * @since 1.6.0
 */

import { join } from "node:path";

import type { JavaSetting } from "../config/types.ts";
import { object, parseJson } from "../config/read.ts";
import { readText } from "../infra/fs.ts";
import { findJava, probeJava } from "../launch/java.ts";

/** 现代加载器安装器的最低要求；拿不到更准确的要求时用它 */
const DEFAULT_TARGET = 17;

export interface JavaCandidate {
    readonly path: string;
    readonly major: number | null;
}

export async function officialJavaOf(
    setting: JavaSetting,
    required?: number | null,
): Promise<string | undefined> {
    const paths = new Set<string>(setting.list.map((entry) => entry.path));
    for (const path of await findJava(setting)) {
        paths.add(path);
    }

    const candidates: JavaCandidate[] = [];
    for (const path of paths) {
        const info = await probeJava(path);
        if (info !== null) {
            candidates.push({ path, major: info.major });
        }
    }
    return pickJava(candidates, required ?? null);
}

// 优先主版本正好等于要求；没有再取比要求大的里面最小的；都不行就取最大的
export function pickJava(
    candidates: readonly JavaCandidate[],
    required: number | null,
): string | undefined {
    if (candidates.length === 0) {
        return undefined;
    }
    const target = required ?? DEFAULT_TARGET;
    const known = candidates.filter(
        (item): item is { path: string; major: number } => item.major !== null,
    );
    const exact = known.find((item) => item.major === target);
    if (exact !== undefined) {
        return exact.path;
    }
    const newer = known
        .filter((item) => item.major > target)
        .sort((left, right) => left.major - right.major);
    if (newer[0] !== undefined) {
        return newer[0].path;
    }
    const any = [...known].sort((left, right) => right.major - left.major);
    return any[0]?.path ?? candidates[0]?.path;
}

// 版本 json 里的 Java 主版本要求：1.12.2 是 8，1.20.6 是 21
export function requiredJavaOf(raw: unknown): number | null {
    const javaVersion = object(object(raw, "version")?.["javaVersion"], "version.javaVersion");
    const major = javaVersion?.["majorVersion"];
    return typeof major === "number" && Number.isFinite(major) ? major : null;
}

// 从基础版本 json 读要求；文件不在或读不出来时给 null，由调用方退回默认
export async function requiredJavaIn(folderPath: string, game: string): Promise<number | null> {
    const path = join(folderPath, "versions", game, `${game}.json`);
    const text = await readText(path);
    if (text === undefined) {
        return null;
    }
    try {
        return requiredJavaOf(parseJson(text, path));
    } catch {
        return null;
    }
}
