/*
 * schemaVersion 迁移
 *
 * 从文件里的版本逐级升到 CURRENT_SCHEMA，缺哪一级就报错，不允许跳级
 * 比 CURRENT_SCHEMA 新的时候不在这里处理：调用方会进入只读模式
 */

import { AppError } from "../error/index.ts";
import { CURRENT_SCHEMA } from "./types.ts";

// 版本 N 怎么改成 N+1。当前只有版本 1，没有历史迁移
const STEPS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {};

export function migrate(raw: Record<string, unknown>, from: number): Record<string, unknown> {
    let current = raw;
    for (let version = from; version < CURRENT_SCHEMA; version++) {
        const step = STEPS[version];
        if (step === undefined) {
            throw new AppError("config", "UnknownError", {
                context: { detail: `缺少 ${version} → ${version + 1} 的迁移步骤` },
            });
        }
        current = step(current);
    }
    return current;
}

// 文件里的版本号；读不出来就按当前版本处理
export function versionOf(raw: Record<string, unknown>): number {
    const value = raw["schemaVersion"];
    return typeof value === "number" && Number.isInteger(value) && value >= 1
        ? value
        : CURRENT_SCHEMA;
}
