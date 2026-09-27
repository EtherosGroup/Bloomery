/**
 * 启动一个实例：把描述符、Java、账户、依赖、参数收成一条命令
 *
 * 只做规划与准备，不 spawn；真正起进程交给调用方，便于先看命令再决定跑不跑
 * 依赖文件（库、客户端 jar、natives）缺失按致命处理，资源对象缺失只统计
 * 只支持隔离：游戏目录就是 versions/<id>
 * @author IsCibocaz
 * @since 1.0.0
 */

import { readFile } from "node:fs/promises";
import { delimiter, join } from "node:path";

import type { Accounts, Folder, Instance, JavaProbe, Setting } from "../config/types.ts";
import {
    classpathOf,
    countAssets,
    extractNatives,
    nativeJars,
    platformContext,
    readAssetIndex,
    type AssetStat,
    type Classpath,
} from "../dependency/index.ts";
import { AppError } from "../error/index.ts";
import { logger } from "../output/index.ts";
import type { InstanceView } from "../version/index.ts";
import { accountFor, type LaunchAccount } from "./account.ts";
import { buildGameArguments, buildJvmArguments, type ArgumentContext } from "./arguments.ts";
import { probeJava, resolveJavaExecutable, resolveJavaFor, type JavaInfo } from "./java.ts";
import { launchOptionsOf, type LaunchOptions } from "./options.ts";

const log = logger("launch");

export const LAUNCHER_NAME = "bloomery";

export interface LaunchPlan {
    readonly executable: string;
    readonly args: readonly string[];
    /** 进程工作目录，也是 --gameDir */
    readonly directory: string;
    readonly java: JavaInfo;
    readonly account: LaunchAccount;
    readonly classpath: Classpath;
    readonly natives: { readonly jars: number; readonly files: number };
    readonly assets: (AssetStat & { readonly index: string }) | null;
    readonly options: LaunchOptions;
    readonly versionName: string;
    /** 缺件提示，不影响预览 */
    readonly warnings: readonly string[];
}

export interface PlanInput {
    readonly setting: Setting;
    readonly folder: Folder;
    /** 配置清单里的那条，取它的 java / 内存 / 参数覆盖 */
    readonly config: Instance | undefined;
    readonly instance: InstanceView;
    readonly accounts: Accounts;
    readonly probes: Readonly<Record<string, JavaProbe>>;
    readonly accountName?: string;
}

export interface PlanOptions {
    /** false 表示预览：不解压 natives，缺件也不报错 */
    readonly prepare?: boolean;
}

export async function planLaunch(
    input: PlanInput,
    planOptions: PlanOptions = {},
): Promise<LaunchPlan> {
    const prepare = planOptions.prepare ?? true;
    const descriptor = input.instance.descriptor;
    if (descriptor === null) {
        throw new AppError("launch", "VersionBroken", {
            context: {
                detail: input.instance.id,
                problem: input.instance.problem ?? "版本 json 读不出来",
            },
        });
    }
    if (descriptor.mainClass === null) {
        throw new AppError("launch", "VersionBroken", {
            context: { detail: `${descriptor.id} 没有 mainClass` },
        });
    }
    // 继承链断了，合并结果里会少一整层的库，没必要往下走
    if (input.instance.problem !== null) {
        throw new AppError("launch", "VersionBroken", {
            context: { detail: input.instance.id, problem: input.instance.problem },
        });
    }

    const warnings: string[] = [];
    const options = launchOptionsOf(input.setting, input.folder, input.config);
    const gameDirectory = input.instance.directory;
    const librariesRoot = join(input.folder.path, "libraries");
    const assetsRoot = join(input.folder.path, "assets");

    // 客户端 jar：加载器版本的 jar 指的是父版本
    const jarId = descriptor.jar ?? input.instance.target;
    const clientJar = join(input.folder.path, "versions", jarId, `${jarId}.jar`);

    const rules = platformContext({
        is_demo_user: false,
        has_custom_resolution: !options.window.fullscreen,
        has_quick_plays_support: false,
    });

    const classpath = await classpathOf({
        libraries: descriptor.libraries,
        context: rules,
        librariesRoot,
        clientJar,
    });
    // 别的启动器装好的目录可能少几个可选库或 natives，先记下来
    if (!classpath.clientJarPresent) {
        warnings.push(`客户端 jar 不在：${clientJar}`);
    }
    if (classpath.missing.length > 0) {
        warnings.push(`缺 ${classpath.missing.length} 个库，已跳过`);
        log.warn("缺 %d 个库，已跳过：%s", classpath.missing.length, classpath.missing.join(", "));
    }

    const natives = await nativeJars({
        libraries: descriptor.libraries,
        context: rules,
        librariesRoot,
    });
    if (natives.missing.length > 0) {
        warnings.push(`缺 ${natives.missing.length} 个 natives`);
        log.warn("缺 %d 个 natives：%s", natives.missing.length, natives.missing.join(", "));
    }

    const nativesDirectory = join(gameDirectory, "natives");
    let files = 0;
    // 预览只算不落盘，缺件也不拦；真启动才补依赖检查与解压
    if (prepare) {
        if (!classpath.clientJarPresent) {
            throw new AppError("launch", "DependencyMissing", {
                context: { detail: `客户端 jar ${clientJar}` },
            });
        }
        if (natives.missing.length > 0) {
            throw new AppError("launch", "DependencyMissing", {
                context: {
                    detail: `${natives.missing.length} 个 natives`,
                    first: natives.missing[0] ?? "",
                },
            });
        }
        files = await extractNatives(natives.jars, nativesDirectory);
    }

    const java = await resolveLaunchJava(input, options, descriptor, warnings);
    const account = accountFor(input.accounts, input.accountName, input.setting.selectedAccount);

    const assetIndex = descriptor.assetIndex?.id ?? descriptor.assets ?? "legacy";
    const index = await readAssetIndex(assetsRoot, assetIndex);
    if (index === null) {
        log.warn("%s 里没有资源索引 %s，游戏可能缺材质与声音", assetsRoot, assetIndex);
    }
    const assets =
        index === null ? null : { index: assetIndex, ...(await countAssets(assetsRoot, index)) };

    const context: ArgumentContext = {
        versionName: descriptor.id,
        versionType: descriptor.type ?? "release",
        gameDirectory,
        assetsRoot,
        assetIndex,
        nativesDirectory,
        librariesRoot,
        classpath: classpath.entries.join(delimiter),
        userName: account.name,
        uuid: account.uuid,
        accessToken: account.accessToken,
        xuid: account.xuid ?? "",
        clientId: "",
        userType: account.userType,
        launcherName: LAUNCHER_NAME,
        launcherVersion: await launcherVersion(),
        width: options.window.width,
        height: options.window.height,
        rules,
    };

    const jvm = buildJvmArguments(descriptor, context, options.memory, options.jvmArgs);
    const game = buildGameArguments(descriptor, context, [
        ...options.gameArgs,
        ...(options.window.fullscreen ? ["--fullscreen"] : []),
    ]);

    return {
        executable: java.path,
        args: [...jvm, descriptor.mainClass, ...game],
        directory: gameDirectory,
        java,
        account,
        classpath,
        natives: { jars: natives.jars.length, files },
        assets,
        options,
        versionName: input.instance.id,
        warnings,
    };
}

async function resolveLaunchJava(
    input: PlanInput,
    options: LaunchOptions,
    descriptor: NonNullable<InstanceView["descriptor"]>,
    warnings: string[],
): Promise<JavaInfo> {
    // 实例或文件夹指定了路径就以它为准
    if (options.javaPath !== null) {
        const path = await resolveJavaExecutable(options.javaPath);
        if (path === undefined) {
            throw new AppError("launch", "JavaNotFound", { context: { detail: options.javaPath } });
        }
        const info = await probeJava(path, "manual");
        if (info === null) {
            throw new AppError("launch", "JavaBroken", { context: { detail: path } });
        }
        return info;
    }

    const required = descriptor.javaVersion?.majorVersion ?? undefined;
    const choice = await resolveJavaFor(input.setting.java, input.probes, required);
    if (choice === undefined) {
        throw new AppError("launch", "JavaNotFound", {
            context: {
                detail:
                    required === undefined
                        ? "清单里没有能用的 Java"
                        : `需要 Java ${required} 或更新`,
                hint: "运行 bloomery java scan",
            },
        });
    }
    if (choice.fallback) {
        const message = `没有 Java ${required}，改用 Java ${choice.info.major ?? "未知"}`;
        warnings.push(message);
        log.warn("%s", message);
    }
    return choice.info;
}

// 读自己的 package.json，读不到就不写版本
async function launcherVersion(): Promise<string> {
    try {
        const text = await readFile(new URL("../../package.json", import.meta.url), "utf8");
        return (JSON.parse(text) as { version?: string }).version ?? "unknown";
    } catch {
        return "unknown";
    }
}
