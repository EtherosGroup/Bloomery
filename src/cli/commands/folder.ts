/**
 * folder 命令：编排游戏文件夹的增删查与重新核对
 *
 * 只写 setting.json，不碰游戏文件
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting, saveSetting } from "../../config/index.ts";
import type { Folder, Instance, Setting } from "../../config/types.ts";
import { AppError } from "../../error/index.ts";
import { logger, print } from "../../output/index.ts";
import {
    findFolder,
    folderIdOf,
    probeFolder,
    readFolder,
    sameFolderPath,
    summarizeFolder,
    type FolderView,
} from "../../version/index.ts";
import type { Context, FolderCommand } from "../parse.ts";
import {
    folderJson,
    folderText,
    printFolder,
    printFolderList,
    type FolderListRow,
} from "./render.ts";

const log = logger("folder");

export async function runFolder(command: FolderCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    switch (command.action) {
        case "list":
            return list(setting, ctx);
        case "add":
            return add(setting, command.target ?? "", command, ctx);
        case "remove":
            return remove(setting, command.target ?? "", ctx);
        case "scan":
            return scan(setting, command.target, ctx);
        case "select":
            return select(setting, command.target ?? "", ctx);
    }
}

// 只看保存过的那些，不扫版本
async function list(setting: Setting, ctx: Context): Promise<void> {
    const rows: FolderListRow[] = [];
    for (const folder of setting.folders) {
        rows.push({
            ...(await summarizeFolder(folder)),
            selected: folder.id === setting.selectedFolder,
        });
    }
    printFolderList(rows, ctx);
}

async function add(
    setting: Setting,
    path: string,
    command: FolderCommand,
    ctx: Context,
): Promise<void> {
    if (path === "") {
        throw new AppError("cli", "UsageError", { context: { detail: "缺少参数 <path>" } });
    }

    const probe = await probeFolder(path);
    if (!probe.exists) {
        throw new AppError("cli", "FolderNotFound", { context: { detail: probe.path } });
    }
    if (!probe.directory) {
        throw new AppError("cli", "FolderUnusable", {
            context: { detail: `${probe.path} 不是目录` },
        });
    }
    const duplicate = setting.folders.find((folder) => sameFolderPath(folder.path, probe.path));
    if (duplicate !== undefined) {
        throw new AppError("cli", "FolderDuplicate", { context: { detail: duplicate.id } });
    }
    if (probe.versions === 0) {
        log.warn("%s 的 versions/ 里没有版本", probe.path);
    }

    const folder: Folder = {
        id: folderIdOf(
            probe.path,
            setting.folders.map((item) => item.id),
        ),
        path: probe.path,
        autoDiscover: true,
        missingEntries: "keep",
        java: null,
        memory: null,
        instances: [],
    };
    // dry-run 只返回能不能加与扫描结果，配置一个字都不写
    if (command.dryRun === true) {
        printFolder(await readFolder(folder), ctx, null);
        return;
    }

    await saveSetting({
        ...setting,
        folders: [...setting.folders, folder],
        selectedFolder:
            command.noSelect === true
                ? setting.selectedFolder
                : (setting.selectedFolder ?? folder.id),
    });

    if (ctx.json) {
        print(
            JSON.stringify(
                { id: folder.id, path: folder.path, versionCount: probe.versions },
                null,
                4,
            ),
        );
        return;
    }
    print(`已添加 ${folder.id}  ${folder.path}（${probe.versions} 个版本）`);
}

async function remove(setting: Setting, target: string, ctx: Context): Promise<void> {
    const folder = findFolder(setting.folders, target);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", { context: { detail: target } });
    }

    await saveSetting({
        ...setting,
        folders: setting.folders.filter((item) => item.id !== folder.id),
        selectedFolder: setting.selectedFolder === folder.id ? null : setting.selectedFolder,
    });

    if (ctx.json) {
        print(JSON.stringify({ removed: folder.id }, null, 4));
        return;
    }
    print(`已移除 ${folder.id}`);
}

// 选默认文件夹：launch / version / install 不带 --folder 时用它
async function select(setting: Setting, target: string, ctx: Context): Promise<void> {
    const folder = findFolder(setting.folders, target);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", { context: { detail: target } });
    }

    await saveSetting({ ...setting, selectedFolder: folder.id });

    if (ctx.json) {
        print(JSON.stringify({ selected: folder.id, path: folder.path }, null, 4));
        return;
    }
    print(`已选择 ${folder.id}  ${folder.path}`);
}

async function scan(setting: Setting, target: string | undefined, ctx: Context): Promise<void> {
    const wanted =
        target === undefined
            ? setting.folders
            : setting.folders.filter((folder) => folder.id === target);
    if (wanted.length === 0) {
        throw new AppError("cli", "FolderNotFound", {
            context: { detail: target ?? "配置里没有游戏文件夹" },
        });
    }

    const views: FolderView[] = [];
    const folders: Folder[] = [];
    for (const folder of setting.folders) {
        if (!wanted.includes(folder)) {
            folders.push(folder);
            continue;
        }
        const view = await readFolder(folder);
        views.push(view);
        folders.push(reconcile(folder, view));
    }
    await saveSetting({ ...setting, folders });

    if (ctx.json) {
        print(
            JSON.stringify(
                views.map((view) => folderJson(view)),
                null,
                4,
            ),
        );
        return;
    }
    print(views.map((view) => folderText(view)).join("\n\n"));
}

// 核对结果写回清单：补上磁盘发现的，drop 掉的已经不在视图里
function reconcile(folder: Folder, view: FolderView): Folder {
    const instances: Instance[] = [];
    for (const instance of view.instances) {
        const original = folder.instances.find((item) => item.id === instance.id);
        if (original !== undefined) {
            instances.push(original);
            continue;
        }
        instances.push({
            id: instance.id,
            target: instance.target,
            loader: instance.loader,
            jvmArgs: [],
            gameArgs: [],
        });
    }
    return { ...folder, instances };
}
