/**
 * version 命令：列出与查看版本
 *
 * 只读磁盘，不动 setting.json
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting, saveSetting } from "../../config/index.ts";
import { launchOptionsOf } from "../../launch/index.ts";
import { print, versioned } from "../../output/index.ts";
import { AppError } from "../../error/index.ts";
import { pickFolder, readFolder } from "../../version/index.ts";
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

    // 详情与启动取同一份 Java：覆盖来自 launchOptionsOf
    const config = folder.instances.find((item) => item.id === instance.id);
    await printInstance(
        view.path,
        instance,
        ctx,
        launchOptionsOf(setting, folder, config).javaPath,
    );
}
