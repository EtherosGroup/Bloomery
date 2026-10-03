/**
 * launch 命令：编排版本、Java、账户、依赖、参数与进程
 *
 * 启动前先查启动文件，缺什么下什么，补不齐就不起进程
 * --repair 只做检查与补全就退出，--dry-run 把缺件数报出来但不落盘
 * 启动一次就把 state 里的启动次数与上次游玩时间更新掉
 * 非零退出码原样带出去，脚本里能直接判断游戏是不是正常结束
 * @author IsCibocaz
 * @since 1.0.0
 */

import { refreshMicrosoft } from "../../auth/index.ts";
import {
    loadAccounts,
    loadSetting,
    loadState,
    microsoftAccount,
    saveAccounts,
    updateState,
    type Account,
    type Accounts,
    type Folder,
    type Setting,
} from "../../config/index.ts";
import { AppError } from "../../error/index.ts";
import {
    needsRefresh,
    pickAccount,
    planLaunch,
    spawnGame,
    type LaunchPlan,
} from "../../launch/index.ts";
import { logger, print, progressReporter, versioned } from "../../output/index.ts";
import {
    chooseInstance,
    clientJarOf,
    descriptorOf,
    firstMissing,
    missingLaunchFiles,
    pickFolder,
    readFolder,
    repairVersion,
    type InstanceView,
    type MissingFiles,
    type RepairReport,
} from "../../version/index.ts";
import type { Context, LaunchCommand } from "../parse.ts";

const log = logger("launch");

export async function runLaunch(command: LaunchCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();

    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", {
            context: { detail: command.folder ?? "配置里没有游戏文件夹" },
        });
    }

    const state = await loadState();
    const view = await readFolder(folder);
    // 指定的优先，其次当前选中的，再次上次启动的
    const pick = chooseInstance(
        view,
        command.version,
        setting.selectedInstance,
        state.lastInstance,
    );
    const instance = pick.instance;
    if (instance === undefined) {
        throw new AppError("cli", "VersionNotFound", {
            context: {
                detail: command.version ?? "没有可启动的版本",
                folder: view.id,
            },
        });
    }

    // 检查永远做，补全只在真要启动时做
    const dryRun = command.dryRun === true;
    const missing = await missingLaunchFiles({ folderPath: folder.path, instance });
    const repaired = dryRun ? null : await ensureFiles(setting, folder, instance, missing, ctx);
    if (command.repair === true && !dryRun) {
        reportRepair(instance.id, folder.path, missing, repaired, ctx);
        return;
    }

    const plan = await planLaunch(
        {
            setting,
            folder,
            config: folder.instances.find((item) => item.id === instance.id),
            instance,
            accounts: await refreshCredentials(
                await loadAccounts(),
                command.account,
                setting,
                !dryRun,
            ),
            probes: state.javaProbe,
            accountName: command.account,
        },
        { prepare: !dryRun },
    );

    report(plan, ctx, dryRun, pick.source === "selected" ? instance.id : null, missing, repaired);
    if (dryRun) {
        return;
    }

    const key = `${folder.id}/${instance.id}`;
    await updateState((current) => ({
        ...current,
        lastFolder: folder.id,
        lastInstance: instance.id,
        instances: {
            ...current.instances,
            [key]: {
                lastPlayedAt: new Date().toISOString(),
                playTimeMinutes: current.instances[key]?.playTimeMinutes ?? 0,
                launchCount: (current.instances[key]?.launchCount ?? 0) + 1,
            },
        },
    }));

    const game = spawnGame(plan.executable, plan.args, plan.directory);
    log.info("游戏进程 pid=%s", game.pid);
    if (!setting.launch.waitForExit) {
        return;
    }

    const code = await game.done;
    log.info("游戏退出 code=%d", code);
    if (code !== 0) {
        process.exitCode = code;
    }
}

// 缺什么下什么；下完再查一遍，还有缺的就把第一处报出来
async function ensureFiles(
    setting: Setting,
    folder: Folder,
    instance: InstanceView,
    missing: MissingFiles,
    ctx: Context,
): Promise<RepairReport | null> {
    if (missing.total === 0) {
        return null;
    }

    const descriptor = descriptorOf(instance);
    const progress = progressReporter(
        ctx.progress ?? (ctx.json ? "off" : setting.appearance.progress),
    );
    try {
        log.info("%s 缺 %d 个文件", instance.id, missing.total);
        const repaired = await repairVersion({
            folderPath: folder.path,
            name: instance.id,
            versionDirectory: instance.directory,
            descriptor,
            clientJar: clientJarOf(folder.path, descriptor, instance),
            assets: missing.assets !== null,
            network: setting.network,
            download: setting.download,
            onProgress: progress.update,
        });

        const after = await missingLaunchFiles({ folderPath: folder.path, instance });
        if (after.total > 0) {
            throw new AppError("launch", "GameFilesMissing", {
                context: { detail: firstMissing(after) ?? instance.id },
            });
        }
        return repaired;
    } finally {
        progress.close();
    }
}

// 微软访问令牌按小时过期；过期或快过期时先续一次，续期用的 client id 存在账号里
async function refreshCredentials(
    accounts: Accounts,
    wanted: string | undefined,
    setting: Setting,
    persist: boolean,
): Promise<Accounts> {
    const account = pickAccount(accounts.accounts, wanted, setting.selectedAccount);
    if (account === undefined || !needsRefresh(account) || account.type !== "microsoft") {
        return accounts;
    }
    const clientId = account.clientId;
    const refreshToken = account.refreshToken;
    if (
        clientId === null ||
        clientId === undefined ||
        refreshToken === null ||
        refreshToken === undefined
    ) {
        return accounts;
    }

    log.info("续期微软账户 %s", account.id);
    const credentials = await refreshMicrosoft({
        clientId,
        refreshToken,
        network: setting.network,
    });

    // id 里带着游戏名，改名后沿用原来的 id，引用它的 selectedAccount 才不会断
    const updated: Account = {
        ...microsoftAccount(credentials.name, clientId, credentials),
        id: account.id,
    };
    const next: Accounts = {
        ...accounts,
        accounts: accounts.accounts.map((item) => (item.id === account.id ? updated : item)),
    };
    if (persist) {
        await saveAccounts(next);
    }
    return next;
}

function report(
    plan: LaunchPlan,
    ctx: Context,
    dryRun: boolean,
    selected: string | null,
    missing: MissingFiles,
    repaired: RepairReport | null,
): void {
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    ...(summary(plan) as object),
                    selectedInstance: selected,
                    missing: missingJson(missing),
                    repair: repairJson(repaired),
                }),
                null,
                4,
            ),
        );
        return;
    }

    const lines: string[] = [];
    if (selected !== null) {
        lines.push(`启动当前已选择的版本 ${selected}（使用 bloomery version select 切换）`);
    }
    lines.push(
        `启动 ${plan.versionName}${dryRun ? "（只预览）" : ""}`,
        `  Java      ${plan.executable}（${describeJava(plan)}）`,
        `  账户      ${plan.account.name}（${plan.account.kind === "offline" ? "离线" : "微软"}）`,
        `  目录      ${plan.directory}`,
        `  classpath ${plan.classpath.entries.length} 项${
            plan.classpath.missing.length === 0
                ? ""
                : `（缺 ${plan.classpath.missing.length} 个：${plan.classpath.missing[0] ?? ""}）`
        }`,
        `  natives   ${plan.natives.jars} 个 jar 解出 ${plan.natives.files} 个文件`,
        assetsLine(plan, missing, dryRun),
    );
    if (missing.total > 0) {
        lines.push(
            dryRun
                ? `  缺件       ${missing.total} 个，启动时会自动补全（${firstMissing(missing) ?? ""}）`
                : `  补全       ${repairText(repaired)}`,
        );
    }
    if (dryRun) {
        lines.push("", command(plan));
    }
    for (const warning of plan.warnings) {
        lines.push(`  警告      ${warning}`);
    }
    print(lines.join("\n"));
}

// --repair：只报检查与补全的结果，不碰启动计划
function reportRepair(
    name: string,
    directory: string,
    missing: MissingFiles,
    repaired: RepairReport | null,
    ctx: Context,
): void {
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    version: name,
                    directory,
                    missing: missingJson(missing),
                    repair: repairJson(repaired),
                }),
                null,
                4,
            ),
        );
        return;
    }

    const lines = [`补全 ${name}`];
    if (repaired === null) {
        lines.push("  缺件       没有");
        print(lines.join("\n"));
        return;
    }

    lines.push(
        `  客户端 jar ${laneText(repaired.clientJar)}`,
        `  库         ${laneText(repaired.libraries)}`,
        `  natives    ${repaired.natives.jars} 个 jar，${laneText(repaired.natives.report)}`,
        repaired.assets === null
            ? "  资源       跳过"
            : `  资源       ${laneText(repaired.assets.objects)}`,
        "  结果       缺件已补齐",
    );
    for (const warning of repaired.warnings) {
        lines.push(`  警告       ${warning}`);
    }
    print(lines.join("\n"));
}

function summary(plan: LaunchPlan): unknown {
    return {
        version: plan.versionName,
        executable: plan.executable,
        java: {
            major: plan.java.major,
            arch: plan.java.arch,
            kind: plan.java.kind,
            vendor: plan.java.vendor,
        },
        account: {
            name: plan.account.name,
            uuid: plan.account.uuid,
            kind: plan.account.kind,
        },
        directory: plan.directory,
        classpath: plan.classpath.entries.length,
        natives: plan.natives,
        assets: plan.assets,
        args: plan.args,
    };
}

function missingJson(missing: MissingFiles): unknown {
    return {
        clientJar: missing.clientJar !== null,
        libraries: missing.libraries.length,
        natives: missing.natives.length,
        assets: missing.assets,
        total: missing.total,
        files: missing.files,
    };
}

function repairJson(repaired: RepairReport | null): unknown {
    if (repaired === null) {
        return null;
    }
    return {
        clientJar: repaired.clientJar,
        libraries: repaired.libraries,
        natives: repaired.natives,
        assets: repaired.assets,
        timing: repaired.timing,
        warnings: repaired.warnings,
    };
}

function repairText(repaired: RepairReport | null): string {
    if (repaired === null) {
        return "没有缺件";
    }
    const reports = laneReports(repaired);
    const downloaded = reports.reduce((sum, item) => sum + item.downloaded, 0);
    const skipped = reports.reduce((sum, item) => sum + item.skipped, 0);
    return `新下 ${downloaded} 个，已有 ${skipped} 个`;
}

function laneText(report: RepairReport["libraries"]): string {
    return `新下 ${report.downloaded}，已有 ${report.skipped}，失败 ${report.failures.length}`;
}

// 规划里的资源那行：索引在本地报条数，整份不在且版本 json 给了地址时报待下载大小
function assetsLine(plan: LaunchPlan, missing: MissingFiles, dryRun: boolean): string {
    if (plan.assets !== null) {
        return `  资源      ${plan.assets.index}：${plan.assets.present}/${plan.assets.total}`;
    }
    if (dryRun && missing.assets !== null && missing.assets.missing === null) {
        return `  资源      索引缺失，需下载索引与全部资源${sizeText(missing.assets.size)}`;
    }
    return "  资源      索引不在，材质与声音可能缺失";
}

// 大小未知时留空，不写数字
function sizeText(bytes: number | null): string {
    return bytes === null ? "" : `约 ${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function laneReports(repaired: RepairReport): RepairReport["libraries"][] {
    return [
        repaired.clientJar,
        repaired.libraries,
        repaired.natives.report,
        ...(repaired.assets === null ? [] : [repaired.assets.index, repaired.assets.objects]),
    ];
}

function describeJava(plan: LaunchPlan): string {
    return [
        plan.java.major === null ? "版本未知" : String(plan.java.major),
        plan.java.kind,
        plan.java.arch ?? "架构未知",
    ].join(" · ");
}

// 参数里有空格时加引号，方便直接贴到终端里跑
function command(plan: LaunchPlan): string {
    const quote = (part: string): string => (/[\s"']/.test(part) ? JSON.stringify(part) : part);
    return [plan.executable, ...plan.args].map(quote).join(" ");
}
