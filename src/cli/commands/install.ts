/**
 * install 命令：编排版本与依赖的补齐
 *
 * 已存在的文件跳过，所以对别的启动器装好的目录来说这一步就是补缺
 * 只要有一样没补齐，最后统一报出来并以非零码退出
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting } from "../../config/index.ts";
import { AppError } from "../../error/index.ts";
import { logger, print } from "../../output/index.ts";
import {
    installVersion,
    pickFolder,
    resolveFolderPath,
    type InstallReport,
    type InstallProgress,
} from "../../version/index.ts";
import type { Context, InstallCommand } from "../parse.ts";

const log = logger("install");

// 每 256 个报一次，免得几万个资源刷屏
const STEP = 256;

export async function runInstall(command: InstallCommand, ctx: Context): Promise<void> {
    if (command.loader !== undefined) {
        throw new AppError("cli", "NotImplemented", {
            context: { detail: `安装加载器 ${command.loader}` },
        });
    }

    const setting = await loadSetting();
    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        const detail = command.folder ?? "配置里没有游戏文件夹";
        throw new AppError("cli", "FolderNotFound", { context: { detail } });
    }

    const report = await installVersion({
        folderPath: resolveFolderPath(folder),
        versionId: command.version,
        network: setting.network,
        download: setting.download,
        assets: command.assets !== false,
        onProgress: ctx.json ? undefined : progress(),
    });
    log.info("安装完成 %s", command.version);

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

function progress(): InstallProgress {
    return (stage, done, total) => {
        if (done === total || done % STEP === 0) {
            print(`  ${stage} ${done}/${total}`);
        }
    };
}

function render(report: InstallReport): string {
    const lines = [
        `安装 ${report.versionId}`,
        `  版本 json  ${report.json === "fetched" ? "新取" : "已有"}`,
        `  客户端 jar ${report.clientJar ? "已有或已下" : "缺失"}`,
        `  ${describe("库", report.libraries)}`,
        `  natives    ${report.natives.jars} 个 jar 解出 ${report.natives.files} 个文件（${counts(report.natives.report)}）`,
    ];

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
