/**
 * version 命令：列出与查看版本
 *
 * 只读磁盘，不动 setting.json
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting } from "../../config/index.ts";
import { AppError } from "../../error/index.ts";
import { pickFolder, readFolder } from "../../version/index.ts";
import type { Context, VersionCommand } from "../parse.ts";
import { printFolder, printInstance } from "./view.ts";

export async function runVersion(command: VersionCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const folder = pickFolder(setting.folders, setting.selectedFolder, command.folder);
    if (folder === undefined) {
        const detail = command.folder ?? "配置里没有游戏文件夹";
        throw new AppError("cli", "FolderNotFound", { context: { detail } });
    }

    const view = await readFolder(folder);
    if (command.action === "list") {
        printFolder(view, ctx);
        return;
    }

    const id = command.id ?? "";
    const instance = view.instances.find((item) => item.id === id);
    if (instance === undefined) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: id, folder: view.id },
        });
    }
    printInstance(view.path, instance, ctx);
}
