/**
 * mod 命令：MOD 检索与安装
 *
 * 装到哪个实例按 --version 定，省略就用上次启动的那个
 * 文件落在实例自己的 mods/ 下，是否连依赖一起装按设置里的 installDependencies，可被 --deps/--no-deps 覆盖
 * @author IsCibocaz
 * @since 1.0.0
 */

import { join } from "node:path";

import { loadSetting, loadState } from "../../config/index.ts";
import type { DownloadSetting, Network, Setting } from "../../config/types.ts";
import { AppError } from "../../error/index.ts";
import type { TransferOptions } from "../../infra/download.ts";
import { sourcesOf } from "../../infra/source.ts";
import { installMod, searchMods, type ModInstallReport } from "../../mod/index.ts";
import { logger, print, renderTable, versioned } from "../../output/index.ts";
import { chooseInstance, pickFolder, readFolder } from "../../version/index.ts";
import type { Context, ModCommand } from "../parse.ts";

const log = logger("mod");

export async function runMod(command: ModCommand, ctx: Context): Promise<void> {
    log.debug("action=%s query=%s", command.action, command.query);
    const setting = await loadSetting();

    // 目前只接了 Modrinth
    if (setting.mod.provider !== "modrinth") {
        throw new AppError("cli", "NotImplemented", {
            context: { detail: `MOD 源 ${setting.mod.provider} 还没接，先把它设成 modrinth` },
        });
    }

    const network = transferOf(setting.network, setting.download);
    if (command.action === "search") {
        return search(command, network, ctx);
    }
    return install(command, setting, network, ctx);
}

async function search(command: ModCommand, network: TransferOptions, ctx: Context): Promise<void> {
    const hits = await searchMods(command.query, { network, limit: command.limit });
    if (ctx.json) {
        print(JSON.stringify(hits, null, 4));
        return;
    }
    if (hits.length === 0) {
        print(`没有找到和 ${command.query} 相关的 MOD`);
        return;
    }

    const rows = hits.map((hit) => [
        hit.title,
        hit.slug,
        count(hit.downloads),
        hit.loaders.slice(0, 4).join(" "),
    ]);
    print(
        renderTable(rows, { indent: "  ", header: ["名称", "标识", "下载", "加载器"] }).join("\n"),
    );
    print("");
    print(`装哪一个：bloomery mod install <标识>   共 ${hits.length} 条`);
}

async function install(
    command: ModCommand,
    setting: Setting,
    network: TransferOptions,
    ctx: Context,
): Promise<void> {
    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", {
            context: { detail: command.folder ?? "配置里没有游戏文件夹" },
        });
    }

    const state = await loadState();
    const view = await readFolder(folder);
    const pick = chooseInstance(
        view,
        command.version,
        setting.selectedInstance,
        state.lastInstance,
    );
    const instance = pick.instance;
    if (instance === undefined) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: command.version ?? "没有可用的版本", folder: view.id },
        });
    }

    const modsDirectory = join(instance.directory, "mods");
    const report = await installMod({
        query: command.query,
        modsDirectory,
        gameVersion: instance.gameVersion,
        loader: instance.loader.type === "vanilla" ? null : instance.loader.type,
        network,
        withDependencies: command.deps ?? setting.mod.installDependencies,
        dryRun: command.dryRun,
    });
    log.info("mod install %s -> %s", report.project.slug, modsDirectory);

    show(report, instance.id, modsDirectory, command, ctx, pick.source === "selected");
}

function show(
    report: ModInstallReport,
    instanceId: string,
    modsDirectory: string,
    command: ModCommand,
    ctx: Context,
    selected: boolean,
): void {
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({ instance: instanceId, mods: modsDirectory, ...report }),
                null,
                4,
            ),
        );
        return;
    }

    const lines = [
        selected
            ? `装到当前已选择的版本 ${instanceId}（使用 bloomery version select 切换）`
            : `装到 ${instanceId}${command.dryRun === true ? "（只预览）" : ""}`,
        `  MOD       ${report.project.title}（${report.project.slug}）`,
        `  版本      ${report.version.number} · ${report.version.type}`,
        `  匹配      ${report.version.gameVersions.join(" ") || "未标注"} / ${
            report.version.loaders.join(" ") || "未标注"
        }`,
        `  目录      ${modsDirectory}`,
    ];
    for (const file of report.files) {
        lines.push(
            `  文件      ${file.filename}  ${bytes(file.size)}${file.skipped ? "（已有）" : ""}`,
        );
    }
    for (const dependency of report.dependencies) {
        lines.push(
            `  依赖      ${dependency.title ?? dependency.projectId ?? "?"}  ${dependency.requirement}`,
        );
    }
    for (const warning of report.warnings) {
        lines.push(`  警告      ${warning}`);
    }
    print(lines.join("\n"));
}

function transferOf(network: Network, download: DownloadSetting): TransferOptions {
    return {
        timeoutMs: network.timeoutMs,
        retries: network.retries,
        proxy: network.proxy ?? null,
        noProxy: network.noProxy,
        verify: download.verify,
        concurrency: network.concurrency,
        sources: sourcesOf(download),
    };
}

function count(value: number): string {
    if (value >= 1_000_000) {
        return `${(value / 1_000_000).toFixed(1)}M`;
    }
    if (value >= 1_000) {
        return `${(value / 1_000).toFixed(1)}K`;
    }
    return String(value);
}

function bytes(value: number): string {
    if (value >= 1024 * 1024) {
        return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    }
    if (value >= 1024) {
        return `${(value / 1024).toFixed(0)} KB`;
    }
    return `${value} B`;
}
