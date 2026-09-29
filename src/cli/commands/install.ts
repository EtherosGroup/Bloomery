/**
 * install 命令：按版本号装一份新的版本目录
 *
 * 目录名就是版本名，重名直接拒绝；名字省略时按版本与加载器推导
 * 只要有一样没补齐，最后统一报出来并以非零码退出
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting } from "../../config/index.ts";
import { AppError } from "../../error/index.ts";
import { logger, print, progressReporter } from "../../output/index.ts";
import {
    installVersion,
    parseLoaderSpec,
    pickFolder,
    resolveFolderPath,
    type InstallReport,
    type LoaderSpec,
} from "../../version/index.ts";
import type { Context, InstallCommand } from "../parse.ts";

const log = logger("install");

export async function runInstall(command: InstallCommand, ctx: Context): Promise<void> {
    let loader: LoaderSpec | null = null;
    if (command.loader !== undefined) {
        const spec = parseLoaderSpec(command.loader);
        if (spec === undefined) {
            throw new AppError("cli", "UsageError", {
                context: {
                    detail: `加载器写法是 <名字> 或 <名字>@<版本>，名字只能是 fabric / forge / neoforge / quilt：${command.loader}`,
                },
            });
        }
        loader = spec;
    }

    const setting = await loadSetting();
    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        const detail = command.folder ?? "配置里没有游戏文件夹";
        throw new AppError("cli", "FolderNotFound", { context: { detail } });
    }

    const progress = progressReporter(ctx.json ? "off" : setting.appearance.progress);
    const report = await installVersion({
        folderPath: resolveFolderPath(folder),
        versionId: command.version,
        name: command.displayName,
        loader,
        network: setting.network,
        download: setting.download,
        assets: command.assets !== false,
        onProgress: progress.update,
    });
    progress.close();
    log.info("安装完成 %s", report.name);

    if (ctx.json) {
        print(JSON.stringify(report, null, 4));
    } else {
        print(render(report));
    }

    const failures = collectFailures(report);
    if (failures.length > 0) {
        throw new AppError("cli", "DependencyMissing", {
            context: {
                detail: `${failures.length} 个文件没下下来`,
                first: failures[0] ?? "",
            },
        });
    }
}

function render(report: InstallReport): string {
    const lines = [`安装 ${report.name}`, `  游戏版本   ${report.versionId}`];

    if (report.loader !== null) {
        lines.push(`  加载器     ${report.loader.name} ${report.loader.version}`);
        lines.push(`  基础版本   ${report.base === "installed" ? "这次顺带装的" : "本来就在"}`);
    }
    lines.push(
        `  启动       bloomery launch ${report.name}`,
        `  客户端 jar ${clientJarText(report)}`,
        `  ${describe("库", report.libraries)}`,
        `  natives    ${report.natives.jars} 个 jar 解出 ${report.natives.files} 个文件（${counts(report.natives.report)}）`,
    );

    if (report.assets === null) {
        lines.push("  资源       跳过");
    } else {
        lines.push(
            `  资源索引   ${counts(report.assets.index)}`,
            `  资源对象   ${counts(report.assets.objects)}`,
        );
    }
    for (const warning of report.warnings) {
        lines.push(`  警告       ${warning}`);
    }
    return lines.join("\n");
}

// 加载器版本自己没有客户端 jar，用的是基础版本那份
function clientJarText(report: InstallReport): string {
    if (report.clientJar) {
        return "已有或已下";
    }
    return report.loader === null ? "缺失" : "用基础版本的";
}

function describe(name: string, report: InstallReport["libraries"]): string {
    return `${name.padEnd(9)}${counts(report)}`;
}

function counts(report: InstallReport["libraries"]): string {
    const megabytes = (report.bytes / 1024 / 1024).toFixed(1);
    return `新下 ${report.downloaded}，已有 ${report.skipped}，失败 ${report.failures.length}，${megabytes} MB`;
}

function collectFailures(report: InstallReport): string[] {
    const failures: string[] = [];
    for (const target of [
        report.libraries,
        report.natives.report,
        ...(report.assets === null ? [] : [report.assets.index, report.assets.objects]),
    ]) {
        for (const failure of target.failures) {
            failures.push(`${failure.target}：${failure.error}`);
        }
    }
    return failures;
}
