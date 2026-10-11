/**
 * 已装 MOD 的删除、禁用与启用
 *
 * 禁用就是把 .jar 改名成 .jar.disabled：加载器只认 .jar，文件内容一个字节都不动
 * 目标先按文件名精确匹配，再按去掉 .jar / .jar.disabled 之后的名字匹配
 * 匹配不上、重名、状态已经对都不抛错，逐条记进 skipped，GUI 重复点不会弹错
 * @author IsCibocaz
 * @since 1.13.0
 */

import { rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { scanMods, type ScannedMod } from "./list.ts";

export type ModAction = "remove" | "disable" | "enable";

/** 机器键，消费方按它分支，不认中文 */
export type ModSkipReason =
    | "not-found"
    | "ambiguous"
    | "already-disabled"
    | "already-enabled"
    | "conflict";

export interface ModChange {
    /** 操作前的文件名 */
    readonly from: string;
    /** 操作后的文件名；remove 为 null */
    readonly to: string | null;
    /** 操作前的绝对路径 */
    readonly path: string;
}

export interface ModSkip {
    readonly target: string;
    readonly reason: ModSkipReason;
}

export interface ModManageReport {
    readonly action: ModAction;
    readonly dryRun: boolean;
    readonly changed: readonly ModChange[];
    readonly skipped: readonly ModSkip[];
}

export interface ModManageInput {
    readonly modsDirectory: string;
    readonly action: ModAction;
    readonly targets: readonly string[];
    readonly dryRun?: boolean;
}

const DISABLED = /\.disabled$/i;

export async function manageMods(input: ModManageInput): Promise<ModManageReport> {
    const files = await scanMods(input.modsDirectory);
    const changed: ModChange[] = [];
    const skipped: ModSkip[] = [];
    const handled = new Set<string>();

    for (const target of new Set(input.targets)) {
        const found = match(target, files);
        if (found === undefined) {
            skipped.push({ target, reason: "not-found" });
            continue;
        }
        if (Array.isArray(found)) {
            skipped.push({ target, reason: "ambiguous" });
            continue;
        }
        if (handled.has(found.filename)) {
            continue;
        }
        handled.add(found.filename);
        const outcome = await apply(found, input, files, changed);
        if (outcome !== null) {
            skipped.push({ target, reason: outcome });
        }
    }

    return { action: input.action, dryRun: input.dryRun === true, changed, skipped };
}

/* ---------- 内部 ---------- */

// 精确命中优先；否则按去掉 .jar / .jar.disabled 的名字找，多个候选算重名
function match(
    target: string,
    files: readonly ScannedMod[],
): ScannedMod | ScannedMod[] | undefined {
    const exact = files.find((file) => file.filename === target);
    if (exact !== undefined) {
        return exact;
    }
    const candidates = files.filter((file) => baseNameOf(file.filename) === target);
    if (candidates.length === 0) {
        return undefined;
    }
    return candidates.length === 1 ? candidates[0] : candidates;
}

function baseNameOf(filename: string): string {
    return filename.replace(DISABLED, "").replace(/\.jar$/i, "");
}

async function apply(
    file: ScannedMod,
    input: ModManageInput,
    files: readonly ScannedMod[],
    changed: ModChange[],
): Promise<ModSkipReason | null> {
    const path = join(input.modsDirectory, file.filename);
    if (input.action === "remove") {
        if (input.dryRun !== true) {
            await rm(path, { force: true });
        }
        changed.push({ from: file.filename, to: null, path });
        return null;
    }

    if (input.action === "disable") {
        if (!file.enabled) {
            return "already-disabled";
        }
        const to = `${file.filename}.disabled`;
        if (files.some((one) => one.filename === to)) {
            return "conflict";
        }
        if (input.dryRun !== true) {
            await rename(path, join(input.modsDirectory, to));
        }
        changed.push({ from: file.filename, to, path });
        return null;
    }

    if (file.enabled) {
        return "already-enabled";
    }
    const to = file.filename.replace(DISABLED, "");
    if (files.some((one) => one.filename === to)) {
        return "conflict";
    }
    if (input.dryRun !== true) {
        await rename(path, join(input.modsDirectory, to));
    }
    changed.push({ from: file.filename, to, path });
    return null;
}
