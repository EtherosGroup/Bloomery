/**
 * 启动用的账户
 *
 * 离线账户的 UUID 由名字推导：OfflinePlayer:<名字> 的 MD5，再按 RFC 4122 v3 打版本位
 * 微软账户不在本轮登录，凭据缺失或过期时报需要重新登录
 * @author IsCibocaz
 * @since 1.0.0
 */

import { createHash } from "node:crypto";

import type { Account, Accounts } from "../config/types.ts";
import { AppError } from "../error/index.ts";

export interface LaunchAccount {
    readonly id: string;
    readonly name: string;
    readonly uuid: string;
    readonly accessToken: string;
    /** 微软账户的 XUID，离线为 null */
    readonly xuid: string | null;
    /** 版本 json 的 --userType */
    readonly userType: "msa" | "legacy";
    readonly kind: "offline" | "microsoft";
}

// OfflinePlayer:<名字> 的 MD5
export function offlineUuid(name: string): string {
    const digest = createHash("md5").update(`OfflinePlayer:${name}`, "utf8").digest();
    digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x30;
    digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80;
    const hex = digest.toString("hex");
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
    ].join("-");
}

export function accountFor(
    accounts: Accounts,
    wanted?: string,
    selected?: string | null,
): LaunchAccount {
    const list = accounts.accounts;
    if (list.length === 0) {
        throw new AppError("launch", "AccountNotFound", {
            context: { detail: "accounts.json 里没有账户" },
        });
    }

    const account = pick(list, wanted, selected);
    if (account === undefined) {
        throw new AppError("launch", "AccountNotFound", {
            context: { detail: wanted ?? selected ?? "没有可用的账户" },
        });
    }
    return resolve(account);
}

// 指定的名字优先，其次 setting 里选的，再次第一个
function pick(
    list: readonly Account[],
    wanted: string | undefined,
    selected: string | null | undefined,
): Account | undefined {
    if (wanted !== undefined) {
        // 先按 id 精确匹配（<游戏名>@<类型>），再退回游戏名：
        // 同一个游戏名可以同时有离线与微软两条，只给名字会挑到先来的那条
        return (
            list.find((account) => account.id === wanted) ??
            list.find((account) => account.name === wanted)
        );
    }
    if (selected !== null && selected !== undefined) {
        const found = list.find((account) => account.id === selected);
        if (found !== undefined) {
            return found;
        }
    }
    return list[0];
}

function resolve(account: Account): LaunchAccount {
    if (account.type === "offline") {
        return {
            id: account.id,
            name: account.name,
            uuid: account.uuid ?? offlineUuid(account.name),
            // 离线模式不校验令牌，给一个非空串
            accessToken: "0",
            xuid: null,
            userType: "legacy",
            kind: "offline",
        };
    }

    if (account.refreshToken === null || account.refreshToken === undefined) {
        throw new AppError("launch", "AccountExpired", { context: { detail: account.name } });
    }
    if (
        account.accessToken === null ||
        account.accessToken === undefined ||
        expired(account.expiresAt)
    ) {
        throw new AppError("launch", "AccountExpired", { context: { detail: account.name } });
    }
    if (account.uuid === null || account.uuid === undefined) {
        throw new AppError("launch", "AccountExpired", {
            context: { detail: `${account.name} 缺 UUID` },
        });
    }

    return {
        id: account.id,
        name: account.name,
        uuid: account.uuid,
        accessToken: account.accessToken,
        xuid: account.xuid ?? null,
        userType: "msa",
        kind: "microsoft",
    };
}

// 过期时间留一分钟余量
function expired(expiresAt: string | null | undefined): boolean {
    if (expiresAt === null || expiresAt === undefined) {
        return true;
    }
    const at = Date.parse(expiresAt);
    return !Number.isFinite(at) || at - Date.now() < 60_000;
}
