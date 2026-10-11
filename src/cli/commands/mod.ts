/**
 * mod 命令：MOD 检索、安装与管理
 *
 * 装到哪个实例按 --version 定，省略就用上次启动的那个；文件落在实例自己的 mods/ 下
 * search 按实例过滤；install 一次接多个目标，装不上的逐条记进 failed，不中断其余
 * remove / disable / enable 的禁用约定是 foo.jar 与 foo.jar.disabled，逐条报告，不抛错
 * @author IsCibocaz
 * @since 1.0.0
 */

import { join } from "node:path";

import { loadSetting, loadState } from "../../config/index.ts";
import type { DownloadSetting, Network, Setting } from "../../config/types.ts";
import {
    enqueue,
    NO_WORKER_ENV,
    startWorker,
    type DownloadTask,
    type WorkerStart,
} from "../../download/index.ts";
import { AppError, errorJson } from "../../error/index.ts";
import type { TransferOptions } from "../../infra/download.ts";
import { sourcesOf } from "../../infra/source.ts";
import {
    installMod,
    listInstalledMods,
    manageMods,
    requireModTarget,
    searchMods,
    type InstalledMod,
    type ModAction,
    type ModInstallReport,
    type ModSkipReason,
} from "../../mod/index.ts";
import {
    logger,
    print,
    PROGRESS_STAGES,
    progressReporter,
    renderTable,
    versioned,
} from "../../output/index.ts";
import { chooseInstance, pickFolder, readFolder } from "../../version/index.ts";
import type { Context, ModCommand } from "../parse.ts";

const log = logger("mod");

const SKIP_TEXT: Readonly<Record<ModSkipReason, string>> = {
    "not-found": "没找到",
    ambiguous: "重名，说不准改哪个",
    "already-disabled": "已经是禁用",
    "already-enabled": "已经是启用",
    conflict: "目标文件名已被占用",
};

const ACTION_TEXT: Readonly<Record<ModAction, string>> = {
    remove: "删除",
    disable: "禁用",
    enable: "启用",
};

export async function runMod(command: ModCommand, ctx: Context): Promise<void> {
    log.debug("action=%s", command.action);
    const setting = await loadSetting();

    // 目前只接了 Modrinth
    if (setting.mod.provider !== "modrinth") {
        throw new AppError("cli", "NotImplemented", {
            context: { detail: `MOD 源 ${setting.mod.provider} 还没接，先把它设成 modrinth` },
        });
    }

    const network = transferOf(setting.network, setting.download);
    switch (command.action) {
        case "search":
            return search(command, setting, network, ctx);
        case "list":
            return list(command, setting, network, ctx);
        case "remove":
        case "disable":
        case "enable":
            return manage(command, command.action, setting, network, ctx);
        default:
            return install(command, setting, network, ctx);
    }
}

/* ---------- 定位实例 ---------- */

interface Located {
    readonly instanceId: string;
    readonly selected: boolean;
    readonly modsDirectory: string;
    readonly loader: string | null;
    readonly gameVersion: string | null;
}

async function locate(command: ModCommand, setting: Setting): Promise<Located> {
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

    return {
        instanceId: instance.id,
        selected: pick.source === "selected",
        modsDirectory: join(instance.directory, "mods"),
        loader: instance.loader.type === "vanilla" ? null : instance.loader.type,
        gameVersion: instance.gameVersion,
    };
}

// 没给 --version / --folder 就不碰配置里的选中项，搜索不需要实例也能用
async function locatedOrNull(command: ModCommand, setting: Setting): Promise<Located | null> {
    if (command.version === undefined && command.folder === undefined) {
        return null;
    }
    return locate(command, setting);
}

/* ---------- search ---------- */

async function search(
    command: ModCommand,
    setting: Setting,
    network: TransferOptions,
    ctx: Context,
): Promise<void> {
    const located = await locatedOrNull(command, setting);
    const loader = command.loader ?? located?.loader ?? null;
    const gameVersion = command.gameVersion ?? located?.gameVersion ?? null;
    const query = command.query ?? "";
    const hits = await searchMods(query, { network, limit: command.limit, loader, gameVersion });

    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    query,
                    instance: located?.instanceId ?? null,
                    gameVersion,
                    loader,
                    hits,
                }),
                null,
                4,
            ),
        );
        return;
    }
    if (hits.length === 0) {
        print(`没有找到和 ${query} 相关的 MOD`);
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
    const scope =
        loader === null && gameVersion === null
            ? ""
            : `（${[gameVersion, loader].filter((one) => one !== null).join(" / ")}）`;
    print(`装哪一个：bloomery mod install <标识>${scope}   共 ${hits.length} 条`);
}

/* ---------- list ---------- */

async function list(
    command: ModCommand,
    setting: Setting,
    network: TransferOptions,
    ctx: Context,
): Promise<void> {
    const located = await locate(command, setting);
    const progress = progressReporter(
        ctx.progress ?? (ctx.json ? "off" : setting.appearance.progress),
    );
    const files = await listInstalledMods({
        modsDirectory: located.modsDirectory,
        network,
        offline: command.offline === true,
        onResolve: (done, total) => progress.update(PROGRESS_STAGES.mod, done, total),
    });

    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    instance: located.instanceId,
                    mods: located.modsDirectory,
                    files,
                }),
                null,
                4,
            ),
        );
        return;
    }
    if (files.length === 0) {
        print(`这个实例没装 MOD：${located.modsDirectory}`);
        return;
    }

    print(
        renderTable(tableRows(files), {
            indent: "  ",
            header: ["名称", "状态", "大小", "版本"],
        }).join("\n"),
    );
    print("");
    print(`共 ${files.length} 个   目录 ${located.modsDirectory}`);
}

function tableRows(files: readonly InstalledMod[]): string[][] {
    return files.map((file) => [
        file.project?.title ?? file.filename,
        file.enabled ? "启用" : "禁用",
        bytes(file.size),
        file.version?.number ?? "—",
    ]);
}

/* ---------- install ---------- */

interface InstallEntry extends ModInstallReport {
    readonly query: string;
    readonly ok: true;
}

interface FailureEntry {
    readonly query: string;
    readonly ok: false;
    readonly code: string;
    readonly detail: string;
    readonly retryable: boolean;
}

async function install(
    command: ModCommand,
    setting: Setting,
    network: TransferOptions,
    ctx: Context,
): Promise<void> {
    const located = await locate(command, setting);
    const targets = [...(command.targets ?? [])];
    // 整批共用一个前置条件：不是加载器实例谁也别装
    requireModTarget(located.loader, located.gameVersion);
    const withDependencies = command.deps ?? setting.mod.installDependencies;

    // --async 一次全部入队，只拉起一次 worker：目标实例与落点在这里定死
    if (command.async === true) {
        const tasks: DownloadTask[] = [];
        for (const target of targets) {
            tasks.push(
                await enqueue({
                    type: "mod-install",
                    target,
                    params: {
                        query: target,
                        modsDirectory: located.modsDirectory,
                        gameVersion: located.gameVersion,
                        loader: located.loader,
                        withDependencies,
                        dryRun: command.dryRun === true,
                    },
                }),
            );
        }
        log.info("mod install 入队 %d 个", tasks.length);
        const start = await startWorker({ home: ctx.home, task: tasks[0]?.id });
        queued(tasks, located.instanceId, ctx, start);
        return;
    }

    const progress = progressReporter(
        ctx.progress ?? (ctx.json ? "off" : setting.appearance.progress),
    );
    const installs: InstallEntry[] = [];
    const failed: FailureEntry[] = [];
    for (const target of targets) {
        try {
            const report = await installMod({
                query: target,
                modsDirectory: located.modsDirectory,
                gameVersion: located.gameVersion,
                loader: located.loader,
                network,
                withDependencies,
                dryRun: command.dryRun,
                onProgress: (done, total, byBytes, _target, existing) =>
                    progress.update(PROGRESS_STAGES.mod, done, total, byBytes, existing),
            });
            log.info("mod install %s -> %s", report.project.slug, located.modsDirectory);
            installs.push({ query: target, ok: true, ...report });
        } catch (error) {
            // 一个目标装不上不影响其余：逐条记下来，最后统一给退出码
            failed.push({ query: target, ok: false, ...failureOf(error) });
        }
    }

    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    instance: located.instanceId,
                    mods: located.modsDirectory,
                    installs,
                    failed,
                }),
                null,
                4,
            ),
        );
    } else {
        print(humanInstalls(installs, failed, located, command));
    }
    if (failed.length > 0) {
        process.exitCode = 1;
    }
}

function humanInstalls(
    installs: readonly InstallEntry[],
    failed: readonly FailureEntry[],
    located: Located,
    command: ModCommand,
): string {
    const lines = [
        located.selected
            ? `装到当前已选择的版本 ${located.instanceId}（使用 bloomery version select 切换）`
            : `装到 ${located.instanceId}${command.dryRun === true ? "（只预览）" : ""}`,
        `  目录      ${located.modsDirectory}`,
    ];
    for (const report of installs) {
        lines.push(`  MOD       ${report.project.title}（${report.project.slug}）`);
        lines.push(`  版本      ${report.version.number} · ${report.version.type}`);
        lines.push(
            `  匹配      ${report.version.gameVersions.join(" ") || "未标注"} / ${
                report.version.loaders.join(" ") || "未标注"
            }`,
        );
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
    }
    for (const failure of failed) {
        lines.push(`  失败      ${failure.query}  ${failure.code}  ${failure.detail}`);
    }
    return lines.join("\n");
}

function failureOf(error: unknown): { code: string; detail: string; retryable: boolean } {
    const envelope = errorJson(error)["error"] as {
        code: string;
        detail: string;
        retryable: boolean;
    };
    return { code: envelope.code, detail: envelope.detail, retryable: envelope.retryable };
}

function queued(
    tasks: readonly DownloadTask[],
    instanceId: string,
    ctx: Context,
    start: WorkerStart,
): void {
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    instance: instanceId,
                    tasks,
                    spawn: { outcome: start.outcome, pid: start.pid, log: start.log },
                }),
                null,
                4,
            ),
        );
        return;
    }
    print(`已加入下载队列 ${tasks.map((task) => task.id).join(" ")}（${instanceId}）`);
    for (const line of workerLines(start)) {
        print(line);
    }
}

// 后台 worker 拉起结果
function workerLines(start: WorkerStart): readonly string[] {
    switch (start.outcome) {
        case "started":
            return [
                `后台下载已开始 pid ${start.pid ?? "未知"}`,
                "进度：bloomery download info",
                `日志：${start.log}`,
            ];
        case "busy":
            return [
                `下载进程已存在 pid ${start.worker ?? "未知"}，下载任务自动加入队列`,
                "进度：bloomery download info",
            ];
        case "disabled":
            return [`后台下载跳过：${NO_WORKER_ENV}=1`, "手动启动下载队列：bloomery download run"];
        default:
            return [
                `后台下载失败：${start.detail ?? "未知错误"}`,
                "手动启动下载队列：bloomery download run",
            ];
    }
}

/* ---------- remove / disable / enable ---------- */

async function manage(
    command: ModCommand,
    action: ModAction,
    setting: Setting,
    network: TransferOptions,
    ctx: Context,
): Promise<void> {
    const located = await locate(command, setting);
    const targets = [...(command.targets ?? [])];
    let report = await manageMods({
        modsDirectory: located.modsDirectory,
        action,
        targets,
        dryRun: command.dryRun,
    });

    // 本地匹配不上的目标可能是 slug 或项目 id，联网反查一次再按文件名重来
    const unresolved = report.skipped
        .filter((skip) => skip.reason === "not-found")
        .map((skip) => skip.target);
    if (unresolved.length > 0 && command.offline !== true) {
        const files = await listInstalledMods({
            modsDirectory: located.modsDirectory,
            network,
        });
        const aliases = new Map<string, string>();
        for (const file of files) {
            if (file.project !== null) {
                aliases.set(file.project.slug, file.filename);
                aliases.set(file.project.id, file.filename);
            }
        }
        const mapped = unresolved.flatMap((target) => {
            const filename = aliases.get(target);
            return filename === undefined ? [] : [{ target, filename }];
        });
        if (mapped.length > 0) {
            const again = await manageMods({
                modsDirectory: located.modsDirectory,
                action,
                targets: mapped.map((one) => one.filename),
                dryRun: command.dryRun,
            });
            const done = new Set(mapped.map((one) => one.target));
            report = {
                action,
                dryRun: report.dryRun,
                changed: [...report.changed, ...again.changed],
                skipped: [
                    ...report.skipped.filter((skip) => !done.has(skip.target)),
                    ...again.skipped,
                ],
            };
        }
    }

    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    instance: located.instanceId,
                    mods: located.modsDirectory,
                    ...report,
                }),
                null,
                4,
            ),
        );
    } else {
        print(humanManage(report.changed, report.skipped, action, located));
    }
    if (report.skipped.length > 0) {
        process.exitCode = 1;
    }
}

function humanManage(
    changed: readonly { readonly from: string; readonly to: string | null }[],
    skipped: readonly { readonly target: string; readonly reason: ModSkipReason }[],
    action: ModAction,
    located: Located,
): string {
    const lines = [
        `${ACTION_TEXT[action]} ${located.instanceId} 的 MOD`,
        `  目录      ${located.modsDirectory}`,
    ];
    for (const change of changed) {
        lines.push(`  已处理    ${change.from}${change.to === null ? "" : ` -> ${change.to}`}`);
    }
    for (const skip of skipped) {
        lines.push(`  跳过      ${skip.target}  ${SKIP_TEXT[skip.reason]}`);
    }
    return lines.join("\n");
}

/* ---------- 杂项 ---------- */

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
