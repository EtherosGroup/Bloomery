/**
 * 路径解析
 * @author IsCibocaz
 * @since 1.0.0
 */

import { homedir } from "node:os";
import { join } from "node:path";

// 用户文件夹：Linux /home/<名字>，Windows C:\Users\<名字>
export function homeDirectory(): string {
    return homedir();
}

// 配置文件夹：<用户文件夹>/.config/bloomery
export function configDirectory(): string {
    return join(homeDirectory(), ".config", "bloomery");
}

// 日志文件夹：<配置文件夹>/logs
export function logDirectory(): string {
    return join(configDirectory(), "logs");
}
