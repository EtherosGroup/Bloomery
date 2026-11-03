/**
 * import 命令：导入其他启动器的数据
 *
 * 目前只认 HMCL 3.16 起（拆分式配置）的数据目录：文件夹、Java、离线账号与选中状态
 * --dry-run 只规划不落盘；落盘顺序是先账号后设置，设置里的选中账号要指向已存在的账号
 * @author IsCibocaz
 * @since 1.16.0
 */

import {
    loadAccounts,
    loadSetting,
    saveAccounts,
    saveSetting,
    updateState,
} from "../../config/index.ts";
import { print, versioned } from "../../output/index.ts";
import { applyHmclImport, planHmclImport, type HmclImportPlan } from "../../importer/index.ts";
import { logger } from "../../output/index.ts";
import type { Setting } from "../../config/types.ts";
import type { Context, ImportCommand } from "../parse.ts";

const log = logger("import");

export async function runImport(command: ImportCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const accounts = await loadAccounts();
    const plan = await planHmclImport({
        path: command.path,
        base: command.base,
        setting,
        accounts,
    });

    if (command.dryRun !== true) {
        const applied = applyHmclImport(plan, setting, accounts);
        if (plan.accounts.added.length > 0) {
            await saveAccounts(applied.accounts);
        }
        const probes = Object.entries(applied.probes);
        if (probes.length > 0) {
            await updateState((state) => ({
                ...state,
                javaProbe: { ...state.javaProbe, ...applied.probes },
            }));
        }
        if (changed(plan, setting)) {
            await saveSetting(applied.setting);
        }
        log.info(
            "导入 HMCL：文件夹 %d、Java %d、账号 %d",
            plan.folders.added.length,
            plan.java.added.length,
            plan.accounts.added.length,
        );
    }

    if (ctx.json) {
        print(JSON.stringify(versioned(report(plan, command.dryRun === true)), null, 4));
        return;
    }
    print(render(plan, command.dryRun === true));
}

// 选中项也算改动：只导入账号时不写 setting 的话 selectedAccount 就落不了盘
function changed(plan: HmclImportPlan, setting: Setting): boolean {
    if (plan.folders.added.length > 0 || plan.java.added.length > 0) {
        return true;
    }
    if (plan.selected.folder !== null && plan.selected.folder !== setting.selectedFolder) {
        return true;
    }
    if (plan.selected.instance !== null && plan.selected.instance !== setting.selectedInstance) {
        return true;
    }
    return plan.selected.account !== null && plan.selected.account !== setting.selectedAccount;
}

function report(plan: HmclImportPlan, dryRun: boolean): Record<string, unknown> {
    return {
        source: {
            kind: "hmcl",
            path: plan.path,
            localHome: plan.localHome,
            userHome: plan.userHome,
        },
        dryRun,
        folders: {
            added: plan.folders.added.map((item) => ({
                id: item.id,
                path: item.path,
                versionCount: item.versionCount,
            })),
            skipped: plan.folders.skipped,
        },
        java: {
            added: plan.java.added.map((item) => item.entry),
            skipped: plan.java.skipped,
        },
        accounts: {
            added: plan.accounts.added,
            skipped: plan.accounts.skipped,
        },
        selected: plan.selected,
        warnings: plan.warnings,
    };
}

const FOLDER_SKIP: Record<string, string> = {
    exists: "已添加过",
    "not-found": "目录不存在",
    "not-directory": "不是目录",
};

const JAVA_SKIP: Record<string, string> = {
    "not-found": "文件不存在",
    broken: "探测失败",
    duplicate: "已在清单里",
};

const ACCOUNT_SKIP: Record<string, string> = {
    credential: "凭据加密，需重新登录",
    yggdrasil: "外置登录，暂不支持",
    duplicate: "已存在",
    unnamed: "没有游戏名",
};

function render(plan: HmclImportPlan, dryRun: boolean): string {
    const lines = [`导入 HMCL 数据  ${plan.path}${dryRun ? "（只预览）" : ""}`];
    lines.push(`  数据目录  local ${plan.localHome ?? "无"} · user ${plan.userHome ?? "无"}`);

    lines.push(
        `  文件夹    新增 ${plan.folders.added.length}，跳过 ${plan.folders.skipped.length}`,
    );
    for (const item of plan.folders.added) {
        lines.push(`    + ${item.id}  ${item.path}  ${item.versionCount} 个版本`);
    }
    for (const item of plan.folders.skipped) {
        lines.push(`    - ${item.path}  ${FOLDER_SKIP[item.reason] ?? item.reason}`);
    }

    lines.push(`  Java      新增 ${plan.java.added.length}，跳过 ${plan.java.skipped.length}`);
    for (const item of plan.java.added) {
        lines.push(
            `    + ${item.entry.path}  ${item.entry.major ?? "?"} · ${item.entry.vendor ?? "未知"}`,
        );
    }
    for (const item of plan.java.skipped) {
        lines.push(`    - ${item.path}  ${JAVA_SKIP[item.reason] ?? item.reason}`);
    }

    lines.push(
        `  账号      新增 ${plan.accounts.added.length}，跳过 ${plan.accounts.skipped.length}`,
    );
    for (const item of plan.accounts.added) {
        lines.push(`    + ${item.name}（离线）`);
    }
    for (const item of plan.accounts.skipped) {
        lines.push(`    - ${item.name}  ${item.type}  ${ACCOUNT_SKIP[item.reason] ?? item.reason}`);
    }

    const selected = [
        plan.selected.folder === null ? null : `文件夹 ${plan.selected.folder}`,
        plan.selected.instance === null ? null : `实例 ${plan.selected.instance}`,
        plan.selected.account === null ? null : `账号 ${plan.selected.account}`,
    ].filter((item): item is string => item !== null);
    lines.push(`  选中      ${selected.length === 0 ? "不变" : selected.join(" · ")}`);

    for (const warning of plan.warnings) {
        lines.push(`  警告      ${warning}`);
    }
    lines.push(dryRun ? "  未写入任何文件" : "  已写入配置");
    return lines.join("\n");
}
