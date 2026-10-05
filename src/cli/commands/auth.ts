/**
 * auth 命令：账户的增删查
 *
 * 账号 id 是 <游戏名>@<类型>，与显示名分开；同一个游戏名可以同时有离线与微软两条
 * 登出与切换不给 --type 时按游戏名在全部账户里找，同名多条报用法错误
 * use 只改 setting 里的当前选中项，不登录也不碰凭据
 * 微软登录走设备码授权：终端给网址与代码，浏览器里授权完这边接着换令牌
 * client id 优先取 --client-id，其次 BLOOMERY_CLIENT_ID；登进来后按账号存下来给续期用
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loginMicrosoft, type DeviceCodePrompt } from "../../auth/index.ts";
import {
    accountId,
    accountsNamed,
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
import { errorJson } from "../../error/handler.ts";
import { logger, print, printError, renderTable, versioned } from "../../output/index.ts";
import type { AuthCommand, Context } from "../parse.ts";

const log = logger("auth");

const TYPES: readonly AccountType[] = ["offline", "microsoft"];

const LABEL: Record<AccountType, string> = { offline: "离线", microsoft: "微软" };

const CLIENT_ID_ENV = "BLOOMERY_CLIENT_ID";

/** 已通过 Mojang 审核的 Bloomery 应用 id */
export const DEFAULT_CLIENT_ID = "77af6809-5d9c-432f-b0cb-7b42b8761e3c";

export async function runAuth(command: AuthCommand, ctx: Context): Promise<void> {
    const type = typeOf(command.type);
    log.debug("action=%s type=%s", command.action, type ?? "any");

    switch (command.action) {
        case "list":
            return list(ctx);
        case "login":
            return (type ?? "offline") === "microsoft"
                ? microsoftLogin(command, ctx)
                : login(required(command.username, "username"), ctx);
        case "logout":
            return logout(required(command.username, "username"), type, ctx);
        case "use":
            return use(required(command.username, "username"), type, ctx);
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
        print(JSON.stringify(versioned(account), null, 4));
        return;
    }
    print(`已添加 ${account.id}`);
}

// 微软登录：设备码提示打到终端，浏览器里授权完这边接着换令牌
// --json 时 stdout 走 NDJSON：device → account，失败时 error 收尾
async function microsoftLogin(command: AuthCommand, ctx: Context): Promise<void> {
    try {
        await microsoftLoginFlow(command, ctx);
    } catch (error) {
        if (!ctx.json) {
            throw error;
        }
        // error 是 stdout 的最后一行，编排层不再补信封
        ctx.jsonErrorEmitted = true;
        print(JSON.stringify(versioned({ event: "error", error: errorJson(error)["error"] })));
        throw error;
    }
}

async function microsoftLoginFlow(command: AuthCommand, ctx: Context): Promise<void> {
    if (command.username !== undefined) {
        throw new AppError("cli", "UsageError", {
            context: { detail: "微软登录的游戏名从账号里取，不用给 <username>" },
        });
    }

    // 内置应用 id：已通过 Mojang 审核，普通用户不用手抄 uuid
    const clientId = command.clientId ?? process.env[CLIENT_ID_ENV] ?? DEFAULT_CLIENT_ID;
    if (clientId === "") {
        throw new AppError("cli", "MicrosoftClientIdMissing", {
            context: { detail: "client id 为空" },
        });
    }

    const setting = await loadSetting();
    const credentials = await loginMicrosoft({
        clientId,
        network: setting.network,
        prompt: (info) => {
            if (ctx.json) {
                print(JSON.stringify(versioned(deviceEvent(info))));
            }
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
        print(JSON.stringify(versioned(accountEvent(account))));
        return;
    }
    print(`已添加 ${account.id}`);
    print(`  UUID  ${account.uuid}`);
}

// 设备码事件，字段名与 GUI 侧冻结的接口一致
function deviceEvent(info: DeviceCodePrompt): Record<string, unknown> {
    return {
        event: "device",
        verificationUri: info.url,
        verificationUriComplete: info.completeUrl,
        userCode: info.code,
        expiresIn: info.expiresIn,
        expiresAt: new Date(Date.now() + info.expiresIn * 1000).toISOString(),
        interval: info.interval,
        message: `在浏览器打开 ${info.url}，输入代码 ${info.code}`,
    };
}

function accountEvent(account: Account): Record<string, unknown> {
    return {
        event: "account",
        account: { name: account.name, uuid: account.uuid ?? null, type: account.type },
    };
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

async function logout(
    username: string,
    type: AccountType | undefined,
    ctx: Context,
): Promise<void> {
    const accounts = await loadAccounts();
    const account = targetAccount(accounts.accounts, username, type);

    await saveAccounts({
        ...accounts,
        accounts: accounts.accounts.filter((item) => item.id !== account.id),
    });

    const setting = await loadSetting();
    if (setting.selectedAccount === account.id) {
        await saveSetting({ ...setting, selectedAccount: null });
    }

    if (ctx.json) {
        print(JSON.stringify(versioned({ removed: account.id }), null, 4));
        return;
    }
    print(`已移除 ${account.id}`);
}

// 只切当前账号：不登录、不刷新、不碰凭据
async function use(username: string, type: AccountType | undefined, ctx: Context): Promise<void> {
    const accounts = await loadAccounts();
    const account = targetAccount(accounts.accounts, username, type);

    const setting = await loadSetting();
    await saveSetting({ ...setting, selectedAccount: account.id });
    log.info("当前账户切到 %s", account.id);

    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({ id: account.id, name: account.name, type: account.type }),
                null,
                4,
            ),
        );
        return;
    }
    print(`当前账户 ${account.id}`);
}

// 给了类型按 id 认；没给类型按游戏名找，同名多条时把类型列出来
function targetAccount(
    list: readonly Account[],
    name: string,
    type: AccountType | undefined,
): Account {
    if (type !== undefined) {
        const id = accountId(name, type);
        const found = list.find((account) => account.id === id);
        if (found === undefined) {
            throw new AppError("cli", "AccountNotFound", { context: { detail: id } });
        }
        return found;
    }

    const found = accountsNamed(list, name);
    const only = found[0];
    if (only === undefined) {
        throw new AppError("cli", "AccountNotFound", { context: { detail: name } });
    }
    if (found.length > 1) {
        throw new AppError("cli", "UsageError", {
            context: {
                detail: `${name} 有 ${found.length} 条同名账户，--type 指明类型：${found
                    .map((account) => account.type)
                    .join(" / ")}`,
            },
        });
    }
    return only;
}

// 没给类型返回 undefined：登出要按游戏名在全部类型里找
function typeOf(value: string | undefined): AccountType | undefined {
    if (value === undefined) {
        return undefined;
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
