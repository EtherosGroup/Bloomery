/**
 * java 命令：编排 Java 清单的增删查与探测
 *
 * scan 把清单与探测结论写回 setting.json 与 state.json，其余动作只读
 * @author IsCibocaz
 * @since 1.0.0
 */

import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { loadSetting, loadState, saveSetting, updateState } from "../../config/index.ts";
import type { JavaEntry, JavaSource, Setting } from "../../config/types.ts";
import { AppError } from "../../error/index.ts";
import {
    javaEntryOf,
    javaPresent,
    javaProbeOf,
    probeJava,
    resolveJava,
    resolveJavaExecutable,
    scanJava,
} from "../../launch/index.ts";
import { logger, print, renderTable } from "../../output/index.ts";
import { expandHome } from "../../platform/index.ts";
import type { Context, JavaCommand } from "../parse.ts";

const log = logger("java");

const SOURCE: Record<JavaSource, string> = {
    manual: "手动",
    detected: "扫描",
    downloaded: "下载",
};

interface Row {
    readonly entry: JavaEntry;
    readonly present: boolean;
}

export async function runJava(command: JavaCommand, ctx: Context): Promise<void> {
    switch (command.action) {
        case "list":
            return list(await loadSetting(), ctx);
        case "scan":
            return scan(ctx);
        case "add":
            return add(await loadSetting(), required(command.target, "path"), ctx);
        case "remove":
            return remove(await loadSetting(), required(command.target, "path"), ctx);
        case "which":
            return which(await loadSetting(), command.major, ctx);
    }
}

async function list(setting: Setting, ctx: Context): Promise<void> {
    const rows = await rowsOf(setting.java.list);
    if (ctx.json) {
        print(JSON.stringify(rows.map(jsonOf), null, 4));
        return;
    }
    if (rows.length === 0) {
        print("还没有记录 Java，运行 bloomery java scan 扫描本机");
        return;
    }
    print(render(rows));
}

async function scan(ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const result = await scanJava(setting.java);
    await saveSetting({ ...setting, java: { ...setting.java, list: result.entries } });
    await updateState((state) => ({
        ...state,
        javaProbe: { ...state.javaProbe, ...result.probes },
    }));
    log.debug("扫描到 %d 个 Java", result.entries.length);

    const rows = await rowsOf(result.entries);
    if (ctx.json) {
        print(JSON.stringify(rows.map(jsonOf), null, 4));
        return;
    }
    print(`扫到 ${rows.length} 个 Java`);
    print(render(rows));
}

async function add(setting: Setting, target: string, ctx: Context): Promise<void> {
    const path = await resolveJavaExecutable(target);
    if (path === undefined) {
        throw new AppError("cli", "JavaNotFound", { context: { detail: target } });
    }

    const key = await realpath(path).catch(() => path);
    for (const entry of setting.java.list) {
        const existing = await realpath(entry.path).catch(() => entry.path);
        if (existing === key) {
            throw new AppError("cli", "JavaDuplicate", { context: { detail: entry.path } });
        }
    }

    const info = await probeJava(path, "manual");
    if (info === null) {
        throw new AppError("cli", "JavaBroken", { context: { detail: path } });
    }

    const entry = javaEntryOf(info);
    await saveSetting({
        ...setting,
        java: { ...setting.java, list: [...setting.java.list, entry] },
    });
    await updateState((state) => ({
        ...state,
        javaProbe: { ...state.javaProbe, [entry.path]: javaProbeOf(info) },
    }));
    log.debug("记录 %s", entry.path);

    if (ctx.json) {
        print(JSON.stringify(entry, null, 4));
        return;
    }
    print(`已添加 ${entry.path}`);
    print(`  ${describe(entry)}`);
}

async function remove(setting: Setting, target: string, ctx: Context): Promise<void> {
    const keys = new Set<string>([resolve(expandHome(target))]);
    const resolved = await resolveJavaExecutable(target);
    if (resolved !== undefined) {
        keys.add(resolved);
        keys.add(await realpath(resolved).catch(() => resolved));
    }

    let found: JavaEntry | undefined;
    for (const entry of setting.java.list) {
        const existing = await realpath(entry.path).catch(() => entry.path);
        if (keys.has(entry.path) || keys.has(existing)) {
            found = entry;
            break;
        }
    }
    if (found === undefined) {
        throw new AppError("cli", "JavaNotFound", { context: { detail: target } });
    }

    await saveSetting({
        ...setting,
        java: { ...setting.java, list: setting.java.list.filter((entry) => entry !== found) },
    });

    if (ctx.json) {
        print(JSON.stringify({ removed: found.path }, null, 4));
        return;
    }
    print(`已移除 ${found.path}`);
}

async function which(setting: Setting, major: number | undefined, ctx: Context): Promise<void> {
    const state = await loadState();
    const info = await resolveJava(setting.java, state.javaProbe, major);
    if (info === undefined) {
        const detail =
            major === undefined ? "清单里没有能用的 Java" : `清单里没有主版本 ${major} 的 Java`;
        throw new AppError("cli", "JavaNotFound", { context: { detail } });
    }
    await updateState((state_) => ({
        ...state_,
        javaProbe: { ...state_.javaProbe, [info.path]: javaProbeOf(info) },
    }));

    const entry = javaEntryOf(info);
    if (ctx.json) {
        print(JSON.stringify({ ...entry, home: info.home }, null, 4));
        return;
    }
    print("选中的 Java");
    print(`  ${entry.path}`);
    print(`  ${describe(entry)}`);
    if (info.home !== null) {
        print(`  home ${info.home}`);
    }
}

/* ---------- 输出 ---------- */

async function rowsOf(entries: readonly JavaEntry[]): Promise<Row[]> {
    const rows: Row[] = [];
    for (const entry of entries) {
        rows.push({ entry, present: await javaPresent(entry.path) });
    }
    return rows;
}

function render(rows: readonly Row[]): string {
    const table = rows.map((row) => [
        row.entry.path,
        row.entry.major === null || row.entry.major === undefined ? "-" : String(row.entry.major),
        row.entry.kind,
        row.entry.arch ?? "-",
        SOURCE[row.entry.source],
        row.entry.vendor ?? "-",
        row.present ? "" : "[文件不在]",
    ]);
    return renderTable(table, { indent: "  ", right: [1] }).join("\n");
}

function jsonOf(row: Row): unknown {
    return { ...row.entry, present: row.present };
}

function describe(entry: JavaEntry): string {
    const parts = [
        entry.major === null || entry.major === undefined ? "版本未知" : `Java ${entry.major}`,
        entry.kind,
        entry.arch ?? "架构未知",
        SOURCE[entry.source],
    ];
    if (entry.vendor !== null && entry.vendor !== undefined) {
        parts.push(entry.vendor);
    }
    return parts.join(" · ");
}

function required(value: string | undefined, name: string): string {
    if (value === undefined || value === "") {
        throw new AppError("cli", "UsageError", { context: { detail: `缺少参数 <${name}>` } });
    }
    return value;
}
