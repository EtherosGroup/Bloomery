/**
 * version 命令：列出、查看、选中、改名、移除与找回版本
 *
 * list / info 只读磁盘；select 只记一条配置
 * rename 改目录名并同步三处引用：配置里的实例键与 target、选中项、state 的统计键
 * remove 把目录挪到 .removed/ 下，配置与统计一个不动；restore 挪回来
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting, saveSetting, updateState } from "../../config/index.ts";
import type { Instance, InstanceStat, Setting } from "../../config/types.ts";
import { launchOptionsOf } from "../../launch/index.ts";
import { print, renderTable, versioned } from "../../output/index.ts";
import { AppError } from "../../error/index.ts";
import {
    listRemoved,
    pickFolder,
    readFolder,
    removedRoot,
    removeVersion,
    renameVersion,
    restoreVersion,
    versionNameOf,
} from "../../version/index.ts";
import type { Context, VersionCommand } from "../parse.ts";
import { printFolder, printInstance } from "./render.ts";

export async function runVersion(command: VersionCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        const detail = command.folder ?? "配置里没有游戏文件夹";
        throw new AppError("cli", "FolderNotFound", { context: { detail } });
    }

    const view = await readFolder(folder);
    if (command.action === "list") {
        printFolder(view, ctx, setting.selectedInstance ?? null);
        return;
    }

    // 被移除的版本不在列表里，也就查不到实例，这两条先于实例查找
    if (command.action === "removed") {
        return removed(folder.id, view.path, ctx);
    }
    if (command.action === "restore") {
        return move(command, setting, folder.id, view.path, true, ctx);
    }

    const id = command.id ?? "";
    const instance = view.instances.find((item) => item.id === id);
    if (instance === undefined) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: id, folder: view.id },
        });
    }

    // 选中只是记一条配置，launch 与 mod install 不给 --version 时用它
    if (command.action === "select") {
        await saveSetting({ ...setting, selectedInstance: instance.id });
        if (ctx.json) {
            print(JSON.stringify(versioned({ selected: instance.id, folder: view.id }), null, 4));
            return;
        }
        print(`已选中 ${instance.id}  ${view.path}`);
        return;
    }

    if (command.action === "rename") {
        return rename(
            command,
            setting,
            folder.id,
            view.instances.map((item) => item.id),
            ctx,
        );
    }

    if (command.action === "remove") {
        return move(command, setting, folder.id, view.path, false, ctx);
    }

    // 详情与启动取同一份 Java：覆盖来自 launchOptionsOf
    const config = folder.instances.find((item) => item.id === instance.id);
    await printInstance(
        view.path,
        instance,
        ctx,
        launchOptionsOf(setting, folder, config).javaPath,
    );
}

// 改名：磁盘先改，再把配置与状态里指向旧名字的地方收干净
async function rename(
    command: VersionCommand,
    setting: Setting,
    folderId: string,
    ids: readonly string[],
    ctx: Context,
): Promise<void> {
    const from = command.id ?? "";
    const to = versionNameOf(command.renameTo ?? "");
    const dryRun = command.dryRun === true;
    const folder = setting.folders.find((item) => item.id === folderId);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", { context: { detail: folderId } });
    }

    if (from === to) {
        done({ id: to, from, folder: folderId, moved: false, rewritten: [], dryRun }, ctx);
        return;
    }
    if (ids.includes(to)) {
        throw new AppError("cli", "VersionExists", { context: { detail: to } });
    }

    const report = await renameVersion({
        folderPath: folder.path,
        from,
        to,
        dryRun,
    });

    if (!dryRun) {
        await saveSetting(renameInSetting(setting, folderId, from, to));
        await updateState((state) => ({
            ...state,
            lastInstance: state.lastInstance === from ? to : state.lastInstance,
            instances: renameStat(state.instances, `${folderId}/${from}`, `${folderId}/${to}`),
        }));
    }

    done(
        {
            id: to,
            from,
            folder: folderId,
            moved: !dryRun,
            rewritten: report.rewritten,
            dryRun,
        },
        ctx,
    );
}

// 配置里三处：实例条目的 id、别的实例的 target、当前选中项
function renameInSetting(setting: Setting, folderId: string, from: string, to: string): Setting {
    return {
        ...setting,
        selectedInstance: setting.selectedInstance === from ? to : setting.selectedInstance,
        folders: setting.folders.map((folder) => {
            if (folder.id !== folderId) {
                return folder;
            }
            return {
                ...folder,
                instances: folder.instances.map((instance) => renameEntry(instance, from, to)),
            };
        }),
    };
}

function renameEntry(instance: Instance, from: string, to: string): Instance {
    const target = instance.target === from ? to : instance.target;
    if (instance.id !== from) {
        return target === instance.target ? instance : { ...instance, target };
    }
    return { ...instance, id: to, target };
}

function renameStat(
    stats: Readonly<Record<string, InstanceStat>>,
    from: string,
    to: string,
): Record<string, InstanceStat> {
    if (!(from in stats)) {
        return { ...stats };
    }
    const next: Record<string, InstanceStat> = { ...stats };
    const moved = stats[from];
    if (moved !== undefined) {
        next[to] = moved;
    }
    delete next[from];
    return next;
}

interface RenameResult {
    readonly id: string;
    readonly from: string;
    readonly folder: string;
    readonly moved: boolean;
    readonly rewritten: readonly string[];
    readonly dryRun: boolean;
}

function done(result: RenameResult, ctx: Context): void {
    if (ctx.json) {
        print(JSON.stringify(versioned(result), null, 4));
        return;
    }
    if (!result.moved) {
        print(
            result.dryRun ? `改名预览 ${result.from} → ${result.id}` : `${result.id} 就是当前名字`,
        );
    } else {
        print(`已改名 ${result.from} → ${result.id}`);
    }
    if (result.rewritten.length > 0) {
        print(`  继承引用 ${result.rewritten.length} 处：${result.rewritten.join(" ")}`);
    }
}

// 移除过的版本都在 <文件夹>/.removed/ 下；没有那个目录就是空的
async function removed(folderId: string, folderPath: string, ctx: Context): Promise<void> {
    const versions = await listRemoved(folderPath);
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    action: "removed",
                    folder: folderId,
                    path: removedRoot(folderPath),
                    versions,
                }),
                null,
                4,
            ),
        );
        return;
    }
    if (versions.length === 0) {
        print(`没有移除过的版本  ${removedRoot(folderPath)}`);
        return;
    }
    const rows = versions.map((version) => [version.id, version.directory]);
    print(renderTable(rows, { indent: "  ", header: ["实例", "位置"] }).join("\n"));
    print("");
    print(`找回：bloomery version restore <实例>   共 ${versions.length} 个`);
}

// 移除与找回只差一个方向：目录挪走或挪回，配置与统计一个不动
async function move(
    command: VersionCommand,
    setting: Setting,
    folderId: string,
    folderPath: string,
    restore: boolean,
    ctx: Context,
): Promise<void> {
    const id = command.id ?? "";
    const dryRun = command.dryRun === true;
    const report = restore
        ? await restoreVersion({ folderPath, id, dryRun })
        : await removeVersion({ folderPath, id, dryRun });

    if (!restore && !dryRun) {
        // 选中的那个被移走了就清掉：它已经不在列表里，留着只会让人以为还在
        if (setting.selectedInstance === id) {
            await saveSetting({ ...setting, selectedInstance: null });
        }
        await updateState((state) => ({
            ...state,
            lastInstance: state.lastInstance === id ? null : state.lastInstance,
        }));
    }

    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    action: restore ? "restore" : "remove",
                    id,
                    folder: folderId,
                    path: report.directory,
                    moved: report.moved,
                    dryRun,
                }),
                null,
                4,
            ),
        );
        return;
    }
    if (restore) {
        print(`已找回 ${id}${dryRun ? "（只预览）" : ""}`);
        print(`  位置      ${report.directory}`);
        return;
    }
    print(`已移除 ${id}${dryRun ? "（只预览）" : ""}，文件没删`);
    print(`  位置      ${report.directory}`);
    print(`  找回      bloomery version restore ${id}`);
}
