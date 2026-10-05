/**
 * 版本 json 合并
 *
 * 加载器版本原先靠 inheritsFrom 引用原版，安装时在这里并成一份自包含 json
 * 合并语义与启动时的内存合并一致：库同名以加载器为准，参数原版在前、加载器在后
 * 标记键 bloomery 记下游戏版本与加载器：inheritsFrom 删掉后，那是认版本的唯一依据
 * @author IsCibocaz
 * @since 1.12.0
 */

/** 标记键，别的启动器会忽略未知键 */
export const MARK_KEY = "bloomery";

export interface MergeInput {
    /** 原版 json */
    readonly base: Record<string, unknown>;
    /** 加载器 json */
    readonly loader: Record<string, unknown>;
    /** 实例名，写进 id */
    readonly name: string;
    readonly gameVersion: string;
    readonly loaderType: string;
    readonly loaderVersion: string;
}

/** 加载器层没有值时由原版层顶上的标量键 */
const INHERITED = [
    "type",
    "mainClass",
    "assets",
    "assetIndex",
    "javaVersion",
    "logging",
    "complianceLevel",
    "minimumLauncherVersion",
] as const;

export function mergeManifests(input: MergeInput): Record<string, unknown> {
    const { base, loader } = input;
    const merged: Record<string, unknown> = { ...base, ...loader };

    // 加载器层显式给 null 时不覆盖原版：这些键缺了游戏就起不来
    for (const key of INHERITED) {
        const value = loader[key] ?? base[key];
        if (value === undefined || value === null) {
            delete merged[key];
        } else {
            merged[key] = value;
        }
    }

    // 库：加载器在前，原版里同名的丢掉，与启动时 mergeDescriptors 的顺序一致
    const libraries = mergeLibraries(base["libraries"], loader["libraries"]);
    if (libraries === undefined) {
        delete merged["libraries"];
    } else {
        merged["libraries"] = libraries;
    }

    const args = mergeArguments(base["arguments"], loader["arguments"]);
    if (args === undefined) {
        delete merged["arguments"];
    } else {
        merged["arguments"] = args;
    }

    // 1.12.2 及以前只有这一串参数，加载器有就用加载器的
    const legacy = loader["minecraftArguments"] ?? base["minecraftArguments"];
    if (legacy === undefined || legacy === null) {
        delete merged["minecraftArguments"];
    } else {
        merged["minecraftArguments"] = legacy;
    }

    // 客户端 jar 的下载信息在原版那份里，加载器层通常没有
    const downloads = { ...asRecord(base["downloads"]), ...asRecord(loader["downloads"]) };
    if (Object.keys(downloads).length === 0) {
        delete merged["downloads"];
    } else {
        merged["downloads"] = downloads;
    }

    // 自包含：不再指向别的版本目录
    delete merged["inheritsFrom"];
    delete merged["jar"];
    merged["id"] = input.name;
    merged[MARK_KEY] = {
        layout: "merged",
        gameVersion: input.gameVersion,
        loader: { type: input.loaderType, version: input.loaderVersion },
    };
    return merged;
}

function mergeLibraries(base: unknown, loader: unknown): unknown[] | undefined {
    const parent = asArray(base);
    const child = asArray(loader);
    if (parent === undefined && child === undefined) {
        return undefined;
    }
    const own = child ?? [];
    const taken = new Set(
        own.map(nameOf).filter((name): name is string => name !== null && name !== ""),
    );
    return [
        ...own,
        ...(parent ?? []).filter((item) => {
            const name = nameOf(item);
            return name === null || !taken.has(name);
        }),
    ];
}

function mergeArguments(base: unknown, loader: unknown): Record<string, unknown> | undefined {
    const parent = asRecord(base);
    const child = asRecord(loader);
    if (parent === undefined && child === undefined) {
        return undefined;
    }
    return {
        ...parent,
        ...child,
        game: [...(asArray(parent?.["game"]) ?? []), ...(asArray(child?.["game"]) ?? [])],
        jvm: [...(asArray(parent?.["jvm"]) ?? []), ...(asArray(child?.["jvm"]) ?? [])],
    };
}

function nameOf(value: unknown): string | null {
    const name = asRecord(value)?.["name"];
    return typeof name === "string" ? name : null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function asArray(value: unknown): unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}
