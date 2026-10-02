/**
 * 路径解析
 * @author IsCibocaz
 * @since 1.0.0
 */

import { homedir } from "node:os";

// --home 指定的数据目录；未指定时用系统家目录
let homeOverride: string | null = null;

export function setHome(directory: string): void {
    homeOverride = directory;
}
import { join } from "node:path";

// 用户文件夹：Linux /home/<名字>，Windows C:\Users\<名字>
export function homeDirectory(): string {
    return homeOverride ?? homedir();
}

// 配置文件夹：<用户文件夹>/.config/bloomery
export function configDirectory(): string {
    return join(homeDirectory(), ".config", "bloomery");
}

// 日志文件夹：<配置文件夹>/logs
export function logDirectory(): string {
    return join(configDirectory(), "logs");
}

// 设置文件：<配置文件夹>/setting.json
export function settingFile(): string {
    return join(configDirectory(), "setting.json");
}

// 账号文件：<配置文件夹>/accounts.json，含凭据
export function accountsFile(): string {
    return join(configDirectory(), "accounts.json");
}

// 状态文件：<配置文件夹>/state.json
export function stateFile(): string {
    return join(configDirectory(), "state.json");
}

// 展开开头的 ~，其余路径原样返回
export function expandHome(path: string): string {
    if (path === "~") {
        return homeDirectory();
    }
    if (path.startsWith("~/") || path.startsWith("~\\")) {
        return join(homeDirectory(), path.slice(2));
    }
    return path;
}

// 从镜像站拉来的源清单
export function mirrorListFile(): string {
    return join(configDirectory(), "mirrors.json");
}
