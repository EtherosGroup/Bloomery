/**
 * 账号文件
 *
 * 含长期凭据，权限收紧到 0600
 * 读不出来就用空列表并留一份备份，重新登录即可
 * @author IsCibocaz
 * @since 1.0.0
 */

import { AppError } from "../error/index.ts";
import { backupFile, readText, restrictMode, writeAtomic } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import { accountsFile } from "../platform/index.ts";
import { defaultAccounts } from "./defaults.ts";
import { migrate, versionOf } from "./migrate.ts";
import { object, parseJson, reader } from "./read.ts";
import { CURRENT_SCHEMA, type Account, type Accounts } from "./types.ts";

const log = logger("config");
const MODE = 0o600;

let readOnly = false;

// 账号文件比程序新时为 true：本次运行不写回
export function accountsReadOnly(): boolean {
    return readOnly;
}

export async function loadAccounts(): Promise<Accounts> {
    const path = accountsFile();
    const text = await readText(path);
    if (text === undefined) {
        readOnly = false;
        return defaultAccounts();
    }
    // 已存在但权限更宽的先收紧
    await restrictMode(path, MODE).catch(() => {});

    const parsed = object(parseJson(text, path), path);
    if (parsed === undefined) {
        const kept = await backupFile(path, true);
        log.warn("%s 读不出来，已挪到 %s，账号按空列表处理", path, kept ?? "(备份失败)");
        readOnly = false;
        return defaultAccounts();
    }

    const version = versionOf(parsed);
    if (version > CURRENT_SCHEMA) {
        readOnly = true;
        log.warn("%s 是格式版本 %d，程序只认到 %d，本次运行不写回", path, version, CURRENT_SCHEMA);
        return defaultAccounts();
    }

    const extras: string[] = [];
    const r = reader("accounts", migrate(parsed, version), extras);
    // 版本号在上面已经处理过，这里只是标记成已读
    r.integer("schemaVersion", CURRENT_SCHEMA, 1);
    const accounts = r.list<Account>("accounts", [], (value, at) => readAccount(value, at, extras));
    r.extra();
    readOnly = false;

    if (extras.length > 0) {
        log.warn("%s 里有不认识的键，已丢弃：%s", path, extras.join(", "));
    }
    return { schemaVersion: CURRENT_SCHEMA, accounts };
}

export async function saveAccounts(accounts: Accounts): Promise<void> {
    if (readOnly) {
        throw new AppError("config", "ConfigTooNew", { context: { detail: accountsFile() } });
    }
    await writeAtomic(accountsFile(), `${JSON.stringify(accounts, null, 4)}\n`, MODE);
}

// 两种账号字段不同，按 type 分派；离线账号里的凭据字段会当成未知键丢掉
function readAccount(value: unknown, at: string, extras: string[]): Account | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, extras);
    const type = r.string("type", "");
    const id = r.string("id", "");
    const name = r.string("name", "");
    if ((type !== "offline" && type !== "microsoft") || id === "" || name === "") {
        log.warn("%s 的 type、id 或 name 不合法，已忽略这个账号", at);
        r.extra();
        return undefined;
    }

    const uuid = r.nullableString("uuid", null);
    if (type === "offline") {
        r.extra();
        return { id, type, name, uuid };
    }

    const account: Account = {
        id,
        type,
        name,
        uuid,
        xuid: r.nullableString("xuid", null),
        refreshToken: r.nullableString("refreshToken", null),
        accessToken: r.nullableString("accessToken", null),
        expiresAt: r.nullableString("expiresAt", null),
    };
    r.extra();
    return account;
}
