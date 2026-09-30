/**
 * modpack 命令：导入整合包
 *
 * 只认 Modrinth 的 .mrpack：按包里的游戏版本与加载器建实例，再下清单里的文件、摊平 overrides/
 * 重名直接拒绝，dry-run 只算不落盘
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting } from "../../config/index.ts";
import { officialJavaOf } from "../java-choice.ts";
import { AppError } from "../../error/index.ts";
import { importModpack, type ModpackImportReport } from "../../modpack/index.ts";
import { logger, print, progressReporter } from "../../output/index.ts";
import { pickFolder, resolveFolderPath } from "../../version/index.ts";
import type { Context, ModpackCommand } from "../parse.ts";

const log = logger("modpack");

export async function runModpack(command: ModpackCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", {
            context: { detail: command.folder ?? "配置里没有游戏文件夹" },
        });
    }

    // 包里要 forge / neoforge 时安装器要用 java；这里统一挑一个，只有那条路会用到
    const officialJava = await officialJavaOf(setting.java);
    const progress = progressReporter(ctx.json ? "off" : setting.appearance.progress);
    const report = await importModpack({
        archive: command.file,
        folderPath: resolveFolderPath(folder),
        name: command.displayName,
        network: setting.network,
        download: setting.download,
        dryRun: command.dryRun,
        assets: command.noAssets !== true,
        officialJava,
        onProgress: progress.update,
        // --json 时不给过程提示，避免污染标准输出
        logLine: ctx.json ? undefined : print,
    });
    progress.close();
    log.info("整合包导入 %s", report.name);

    if (ctx.json) {
        print(JSON.stringify(report, null, 4));
        return;
    }
    print(render(report, command.dryRun === true));
}

function render(report: ModpackImportReport, dryRun: boolean): string {
    const loader =
        report.pack.loader === null
            ? "无"
            : `${report.pack.loader.name} ${report.pack.loader.version}`;
    const lines = [
        `导入 ${report.name}${dryRun ? "（只预览）" : ""}`,
        `  整合包     ${report.pack.name ?? "（无名）"}  Minecraft ${report.pack.versionId}`,
        `  加载器     ${loader}`,
        `  文件       ${
            dryRun
                ? `待下 ${report.files.total} 个`
                : `新下 ${report.files.downloaded}，已有 ${report.files.skipped}，失败 ${report.files.failures.length}`
        }`,
    ];
    if (!dryRun) {
        lines.push(`  覆盖       ${report.overrides} 个文件`);
    }
    for (const warning of report.warnings) {
        lines.push(`  警告       ${warning}`);
    }
    lines.push(`  启动       bloomery launch ${report.name}`);
    return lines.join("\n");
}
