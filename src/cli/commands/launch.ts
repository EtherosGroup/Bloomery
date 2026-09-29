/**
 * launch 命令：编排版本、Java、账户、依赖、参数与进程
 *
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
import { logger, print } from "../../output/index.ts";
import { pickFolder, pickInstance, readFolder } from "../../version/index.ts";
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
    const instance = pickInstance(view, command.version, state.lastInstance);
    if (instance === undefined) {
        throw new AppError("cli", "VersionNotFound", {
            context: {
                detail: command.version ?? "没有可启动的版本",
                folder: view.id,
            },
        });
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
                command.dryRun !== true,
            ),
            probes: state.javaProbe,
            accountName: command.account,
        },
        { prepare: command.dryRun !== true },
    );

    report(plan, ctx, command.dryRun === true);
    if (command.dryRun === true) {
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

function report(plan: LaunchPlan, ctx: Context, dryRun: boolean): void {
    if (ctx.json) {
        print(JSON.stringify(summary(plan), null, 4));
        return;
    }

    const lines = [
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
        plan.assets === null
            ? "  资源      索引不在，材质与声音可能缺失"
            : `  资源      ${plan.assets.index}：${plan.assets.present}/${plan.assets.total}`,
    ];
    if (dryRun) {
        lines.push("", command(plan));
    }
    for (const warning of plan.warnings) {
        lines.push(`  警告      ${warning}`);
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
