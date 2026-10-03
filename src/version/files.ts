/**
 * 启动文件的落点与缺失检测
 *
 * 客户端 jar、库、natives 齐了才谈得上启动，判据与规划启动用的是同一套
 * 资源索引不在本地说明这份实例没按带资源的布局装，那时资源不算缺件
 * @author IsCibocaz
 * @since 1.10.0
 */

import { join } from "node:path";

import {
    classpathOf,
    countAssets,
    nativeJars,
    platformContext,
    readAssetIndex,
    type AssetStat,
    type RuleContext,
} from "../dependency/index.ts";
import { AppError } from "../error/index.ts";
import type { Descriptor } from "./descriptor.ts";

/** JSON 里最多列出这么多条缺件路径 */
const FILE_SAMPLE = 8;

export interface MissingFiles {
    /** 缺的客户端 jar，齐了为 null */
    readonly clientJar: string | null;
    readonly libraries: readonly string[];
    readonly natives: readonly string[];
    /** 索引在本地时才有，含 total / present / missing */
    readonly assets: AssetStat | null;
    /** 四类缺件总数 */
    readonly total: number;
    /** 缺件路径，客户端 jar、库、natives 依次在前，最多 FILE_SAMPLE 条 */
    readonly files: readonly string[];
}

export interface MissingParts {
    /** 客户端 jar 的落点与在不在 */
    readonly clientJar: { readonly path: string; readonly present: boolean };
    readonly libraries: readonly string[];
    readonly natives: readonly string[];
    readonly assets: AssetStat | null;
}

/** 版本目录里读出来的实例信息，InstanceView 满足这个形状 */
export interface InstanceFiles {
    readonly id: string;
    readonly target: string;
    readonly chain: readonly string[];
    readonly directory: string;
    readonly descriptor: Descriptor | null;
    readonly problem: string | null;
}

export interface MissingInput {
    /** 游戏文件夹路径，与规划启动用的是同一个 */
    readonly folderPath: string;
    readonly instance: InstanceFiles;
    /** 省略按当前平台 */
    readonly context?: RuleContext | undefined;
}

// 客户端 jar 的落点：继承型用基础版本那份，自带的就在自己目录里
// 不能用 descriptor.inheritsFrom 判断：descriptor 是合并过的，那里永远是 null
export function clientJarOf(
    folderPath: string,
    descriptor: Descriptor,
    instance: Pick<InstanceFiles, "id" | "target" | "chain">,
): string {
    const jarId = descriptor.jar ?? (instance.chain.length > 1 ? instance.target : instance.id);
    return join(folderPath, "versions", jarId, `${jarId}.jar`);
}

export function assetIndexIdOf(descriptor: Descriptor): string {
    return descriptor.assetIndex?.id ?? descriptor.assets ?? "legacy";
}

/** 读不出来或继承链断了的版本没有可补的文件 */
export function descriptorOf(instance: InstanceFiles): Descriptor {
    if (instance.descriptor === null) {
        throw new AppError("launch", "VersionBroken", {
            context: {
                detail: instance.id,
                problem: instance.problem ?? "版本 json 读不出来",
            },
        });
    }
    if (instance.problem !== null) {
        throw new AppError("launch", "VersionBroken", {
            context: { detail: instance.id, problem: instance.problem },
        });
    }
    return instance.descriptor;
}

// 一处判定：规划启动与补全都经过它，两边不会各认一套
export function missingOf(parts: MissingParts): MissingFiles {
    const files = [
        ...(parts.clientJar.present ? [] : [parts.clientJar.path]),
        ...parts.libraries,
        ...parts.natives,
    ];
    return {
        clientJar: parts.clientJar.present ? null : parts.clientJar.path,
        libraries: parts.libraries,
        natives: parts.natives,
        assets: parts.assets,
        total: files.length + (parts.assets?.missing ?? 0),
        files: files.slice(0, FILE_SAMPLE),
    };
}

// 查一份实例缺哪些启动文件；只读，不落盘
export async function missingLaunchFiles(input: MissingInput): Promise<MissingFiles> {
    const descriptor = descriptorOf(input.instance);
    const context = input.context ?? platformContext();
    const librariesRoot = join(input.folderPath, "libraries");
    const assetsRoot = join(input.folderPath, "assets");
    const clientJar = clientJarOf(input.folderPath, descriptor, input.instance);

    const natives = await nativeJars({
        libraries: descriptor.libraries,
        context,
        librariesRoot,
    });
    const classpath = await classpathOf({
        libraries: descriptor.libraries,
        context,
        librariesRoot,
        clientJar,
    });
    const index = await readAssetIndex(assetsRoot, assetIndexIdOf(descriptor));
    const assets = index === null ? null : await countAssets(assetsRoot, index);

    return missingOf({
        clientJar: { path: clientJar, present: classpath.clientJarPresent },
        libraries: classpath.missing,
        natives: natives.missing,
        assets,
    });
}

/** 缺件的第一处，用于定位 */
export function firstMissing(missing: MissingFiles): string | null {
    if (missing.clientJar !== null) {
        return `客户端 jar ${missing.clientJar}`;
    }
    const library = missing.libraries[0];
    if (library !== undefined) {
        return `库 ${library}`;
    }
    const native = missing.natives[0];
    if (native !== undefined) {
        return `natives ${native}`;
    }
    if (missing.assets !== null && missing.assets.missing > 0) {
        return `${missing.assets.missing} 个资源对象`;
    }
    return null;
}
