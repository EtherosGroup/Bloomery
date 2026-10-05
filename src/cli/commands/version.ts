/**
 * version 命令：列出、查看、选中与改名版本
 *
 * list / info 只读磁盘；select 只记一条配置
 * rename 改目录名并同步三处引用：配置里的实例键与 target、选中项、state 的统计键
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting, saveSetting, updateState } from "../../config/index.ts";
import type { Instance, InstanceStat, Setting } from "../../config/types.ts";
import { launchOptionsOf } from "../../launch/index.ts";
import { print, versioned } from "../../output/index.ts";
import { AppError } from "../../error/index.ts";
import { pickFolder, readFolder, renameVersion, versionNameOf } from "../../version/index.ts";
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
