/**
 * auth 命令：账户的增删查
 *
 * 账号 id 是 <游戏名>@<类型>，与显示名分开；同一个游戏名可以同时有离线与微软两条
 * 微软登录走设备码授权：终端给网址与代码，浏览器里授权完这边接着换令牌
 * client id 优先取 --client-id，其次 BLOOMERY_CLIENT_ID；登进来后按账号存下来给续期用
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loginMicrosoft } from "../../auth/index.ts";
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
import { logger, print, printError, renderTable } from "../../output/index.ts";
import type { AuthCommand, Context } from "../parse.ts";

const log = logger("auth");

const TYPES: readonly AccountType[] = ["offline", "microsoft"];

const LABEL: Record<AccountType, string> = { offline: "离线", microsoft: "微软" };

const CLIENT_ID_ENV = "BLOOMERY_CLIENT_ID";

export async function runAuth(command: AuthCommand, ctx: Context): Promise<void> {
    const type = typeOf(command.type);
    log.debug("action=%s type=%s", command.action, type);

    switch (command.action) {
        case "list":
            return list(ctx);
        case "login":
            return type === "microsoft"
                ? microsoftLogin(command, ctx)
                : login(required(command.username, "username"), ctx);
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
                rows.map((row) => ({
                    ...publicAccount(row.account),
                    selected: row.selected,
                    status: row.status,
                })),
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

async function login(username: string, ctx: Context): Promise<void> {
    const accounts = await loadAccounts();
    const account = offlineAccount(username);
    if (accounts.accounts.some((item) => item.id === account.id)) {
        throw new AppError("cli", "AccountExists", { context: { detail: account.id } });
    }
    await saveAccounts({ ...accounts, accounts: [...accounts.accounts, account] });

    // 登录通常就是要用它，顺手设成当前账号
    const setting = await loadSetting();
    await saveSetting({ ...setting, selectedAccount: account.id });

    if (ctx.json) {
        print(JSON.stringify(account, null, 4));
        return;
    }
    print(`已添加 ${account.id}`);
}

// 微软登录：设备码提示打到终端，浏览器里授权完这边接着换令牌
async function microsoftLogin(command: AuthCommand, ctx: Context): Promise<void> {
    if (command.username !== undefined) {
        throw new AppError("cli", "UsageError", {
            context: { detail: "微软登录的游戏名从账号里取，不用给 <username>" },
        });
    }

    const clientId = command.clientId ?? process.env[CLIENT_ID_ENV] ?? "";
    if (clientId === "") {
        throw new AppError("cli", "MicrosoftClientIdMissing", {
            context: { detail: `没给 --client-id，环境变量 ${CLIENT_ID_ENV} 也是空的` },
        });
    }

    const setting = await loadSetting();
    const credentials = await loginMicrosoft({
        clientId,
        network: setting.network,
        prompt: (info) => {
            const minutes = Math.max(1, Math.round(info.expiresIn / 60));
            const lines = [
                "",
                `在浏览器打开：${info.url}`,
                `输入代码：${info.code}`,
                `（${minutes} 分钟内有效，授权完成后这边自动继续）`,
            ].join("\n");
            // JSON 模式下提示走 stderr，stdout 留给结果
            if (ctx.json) {
                printError(lines);
            } else {
                print(lines);
            }
        },
    });

    const accounts = await loadAccounts();
    const account = microsoftAccount(credentials.name, clientId, credentials);
    const rest = accounts.accounts.filter((item) => item.id !== account.id);
    await saveAccounts({ ...accounts, accounts: [...rest, account] });
    await saveSetting({ ...setting, selectedAccount: account.id });
    log.info("微软登录成功 %s", account.id);

    if (ctx.json) {
        print(JSON.stringify(publicAccount(account), null, 4));
        return;
    }
    print(`已添加 ${account.id}`);
    print(`  UUID  ${account.uuid}`);
}

// 令牌不进 JSON 输出
function publicAccount(account: Account): Record<string, unknown> {
    const out: Record<string, unknown> = {
        id: account.id,
        type: account.type,
        name: account.name,
        uuid: account.uuid ?? null,
    };
    if (account.type === "microsoft") {
        out["xuid"] = account.xuid ?? null;
        out["expiresAt"] = account.expiresAt ?? null;
        out["hasCredential"] = account.refreshToken !== null && account.refreshToken !== undefined;
    }
    return out;
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
        context: { detail: `账号类型只能是 ${typeList()}：${value}` },
    });
}

// 取值要写英文，所以把中文名一起列出来
function typeList(): string {
    return TYPES.map((type) => `${type}（${LABEL[type]}）`).join(" / ");
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
