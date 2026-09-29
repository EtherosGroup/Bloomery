/**
 * auth 命令：账户的增删查
 *
 * 账号 id 是 <游戏名>@<类型>，与显示名分开；同一个游戏名可以同时有离线与微软两条
 * 微软登录还没做，login 只记一条凭据为空的，启动时会提示需要重新登录
 * @author IsCibocaz
 * @since 1.0.0
 */

import {
    accountId,
    loadAccounts,
    loadSetting,
    microsoftAccount,
    offlineAccount,
    saveAccounts,
    saveSetting,
    type Account,
    type AccountType,
} from "../../config/index.ts";
import { AppError } from "../../error/index.ts";
import { logger, print, renderTable } from "../../output/index.ts";
import type { AuthCommand, Context } from "../parse.ts";

const log = logger("auth");

const TYPES: readonly AccountType[] = ["offline", "microsoft"];

const LABEL: Record<AccountType, string> = { offline: "离线", microsoft: "微软" };

export async function runAuth(command: AuthCommand, ctx: Context): Promise<void> {
    const type = typeOf(command.type);
    log.debug("action=%s type=%s", command.action, type);

    switch (command.action) {
        case "list":
            return list(ctx);
        case "login":
            return login(required(command.username, "username"), type, ctx);
        case "logout":
            return logout(required(command.username, "username"), type, ctx);
    }
}

async function list(ctx: Context): Promise<void> {
    const accounts = await loadAccounts();
    const setting = await loadSetting();
    const rows = accounts.accounts.map((account) => ({
        account,
        selected: account.id === setting.selectedAccount,
        status: statusOf(account),
    }));

    if (ctx.json) {
        print(
            JSON.stringify(
                rows.map((row) => ({ ...row.account, selected: row.selected, status: row.status })),
                null,
                4,
            ),
        );
        return;
    }
    if (rows.length === 0) {
        print("还没有账户，运行 bloomery auth login <游戏名>");
        return;
    }

    const table = rows.map((row) => [
        row.account.id,
        LABEL[row.account.type],
        row.status,
        row.selected ? "是" : "",
    ]);
    print(
        renderTable(table, { indent: "  ", header: ["账号", "类型", "状态", "当前"] }).join("\n"),
    );
}

async function login(username: string, type: AccountType, ctx: Context): Promise<void> {
    const accounts = await loadAccounts();
    const id = accountId(username, type);
    if (accounts.accounts.some((account) => account.id === id)) {
        throw new AppError("cli", "AccountExists", { context: { detail: id } });
    }

    const account = type === "offline" ? offlineAccount(username) : microsoftAccount(username);
    await saveAccounts({ ...accounts, accounts: [...accounts.accounts, account] });

    // 登录通常就是要用它，顺手设成当前账号
    const setting = await loadSetting();
    await saveSetting({ ...setting, selectedAccount: id });

    if (ctx.json) {
        print(JSON.stringify(account, null, 4));
        return;
    }
    print(`已添加 ${id}`);
    if (type !== "offline") {
        print("  微软登录还没做，这条现在没有凭据，启动时会提示需要重新登录");
    }
}

async function logout(username: string, type: AccountType, ctx: Context): Promise<void> {
    const accounts = await loadAccounts();
    const id = accountId(username, type);
    if (!accounts.accounts.some((account) => account.id === id)) {
        throw new AppError("cli", "AccountNotFound", { context: { detail: id } });
    }

    await saveAccounts({
        ...accounts,
        accounts: accounts.accounts.filter((account) => account.id !== id),
    });

    const setting = await loadSetting();
    if (setting.selectedAccount === id) {
        await saveSetting({ ...setting, selectedAccount: null });
    }

    if (ctx.json) {
        print(JSON.stringify({ removed: id }, null, 4));
        return;
    }
    print(`已移除 ${id}`);
}

// 没给类型按离线；给错类型是用法问题，直接列出来
function typeOf(value: string | undefined): AccountType {
    if (value === undefined) {
        return "offline";
    }
    if ((TYPES as readonly string[]).includes(value)) {
        return value as AccountType;
    }
    throw new AppError("cli", "UsageError", {
        context: { detail: `账号类型只能是 ${TYPES.join(" / ")}：${value}` },
    });
}

function statusOf(account: Account): string {
    if (account.type === "offline") {
        return "可用";
    }
    if (account.refreshToken === null || account.refreshToken === undefined) {
        return "需要登录";
    }
    const expiresAt =
        account.expiresAt === null || account.expiresAt === undefined
            ? Number.NaN
            : Date.parse(account.expiresAt);
    return Number.isFinite(expiresAt) && expiresAt > Date.now() ? "可用" : "凭据过期";
}

function required(value: string | undefined, name: string): string {
    if (value === undefined || value === "") {
        throw new AppError("cli", "UsageError", { context: { detail: `缺少参数 <${name}>` } });
    }
    return value;
}
