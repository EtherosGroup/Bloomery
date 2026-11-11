/**
 * HMCL 数据导入
 *
 * 一次性的迁移：读 HMCL 3.16 起（拆分式配置）的数据目录，规划出要并进 Bloomery 配置的
 * 文件夹、Java、离线账号与选中状态。只规划不落盘，写 setting.json / accounts.json 由命令层做
 * 不迁移微软令牌（新格式加密存储）与外置登录账号，只记进 warnings
 * 3.16 之前的单文件 hmcl.json 不认
 * @author IsCibocaz
 * @since 1.16.0
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { Accounts, Folder, JavaEntry, OfflineAccount, Setting } from "../config/types.ts";
import { offlineAccount } from "../config/accounts.ts";
import { AppError } from "../error/index.ts";
import { readText } from "../infra/fs.ts";
import { javaEntryOf, javaProbeOf, probeJava } from "../launch/index.ts";
import { expandHome, platform } from "../platform/index.ts";
import {
    folderIdOf,
    probeFolder,
    readFolder,
    resolveFolderPath,
    sameFolderPath,
} from "../version/index.ts";

/* ---------- 形状 ---------- */

export interface ImportedFolder {
    readonly id: string;
    readonly path: string;
    readonly versionCount: number;
    /** 待写进 setting.json 的配置项 */
    readonly folder: Folder;
}

export type FolderSkipReason = "exists" | "not-found" | "not-directory";

export interface SkippedFolder {
    readonly path: string;
    readonly reason: FolderSkipReason;
}

export interface ImportedJava {
    readonly entry: JavaEntry;
    /** 探测结论，命令层顺手写进 state.json 的 javaProbe */
    readonly probe: ReturnType<typeof javaProbeOf>;
}

export type JavaSkipReason = "not-found" | "broken" | "duplicate";

export interface SkippedJava {
    readonly path: string;
    readonly reason: JavaSkipReason;
}

export type AccountSkipReason = "credential" | "yggdrasil" | "duplicate" | "unnamed";

export interface SkippedAccount {
    readonly name: string;
    readonly type: string;
    readonly reason: AccountSkipReason;
}

export interface HmclSelection {
    /** Bloomery 的文件夹 id，null 表示不改 */
    readonly folder: string | null;
    readonly instance: string | null;
    readonly account: string | null;
}

export interface HmclImportPlan {
    readonly path: string;
    readonly base: string;
    readonly localHome: string | null;
    readonly userHome: string | null;
    readonly folders: {
        readonly added: readonly ImportedFolder[];
        readonly skipped: readonly SkippedFolder[];
    };
    readonly java: {
        readonly added: readonly ImportedJava[];
        readonly skipped: readonly SkippedJava[];
    };
    readonly accounts: {
        readonly added: readonly OfflineAccount[];
        readonly skipped: readonly SkippedAccount[];
    };
    readonly selected: HmclSelection;
    readonly warnings: readonly string[];
}

export interface HmclImportInput {
    readonly path: string;
    /** 相对路径的基准目录，默认家目录（HMCL 的工作目录） */
    readonly base?: string | undefined;
    readonly setting: Setting;
    readonly accounts: Accounts;
}

export interface HmclApplyResult {
    readonly setting: Setting;
    readonly accounts: Accounts;
    /** 待并进 state.javaProbe 的键值 */
    readonly probes: Readonly<Record<string, ReturnType<typeof javaProbeOf>>>;
}

/* ---------- 入口 ---------- */

export async function planHmclImport(input: HmclImportInput): Promise<HmclImportPlan> {
    const target = resolve(expandHome(input.path));
    const homes = await locateHomes(target);
    if (homes.localHome === null && homes.userHome === null) {
        throw new AppError("cli", "ImportUnrecognized", { context: { detail: target } });
    }

    const base = resolve(expandHome(input.base ?? defaultBase(homes)));
    const warnings: string[] = [];

    const folders = await planFolders(input.setting, homes, base);
    const java = await planJava(input.setting, homes, base);
    const accounts = await planAccounts(input.accounts, homes, warnings);
    const selected = await planSelection(input.setting, homes, folders, accounts);

    return {
        path: target,
        base,
        localHome: homes.localHome,
        userHome: homes.userHome,
        folders: folders.plan,
        java: java.plan,
        accounts: accounts.plan,
        selected,
        warnings,
    };
}

/** 把规划并进配置；不做任何 IO */
export function applyHmclImport(
    plan: HmclImportPlan,
    setting: Setting,
    accounts: Accounts,
): HmclApplyResult {
    const addedJava = plan.java.added;
    // 换了当前文件夹时旧实例已经不在这层，必须一起换；没换文件夹时找不到实例就保留原来的选中
    const folderChanged =
        plan.selected.folder !== null && plan.selected.folder !== (setting.selectedFolder ?? null);
    const nextSetting: Setting = {
        ...setting,
        folders: [...setting.folders, ...plan.folders.added.map((item) => item.folder)],
        java: {
            ...setting.java,
            list: [...setting.java.list, ...addedJava.map((item) => item.entry)],
        },
        selectedFolder: plan.selected.folder ?? setting.selectedFolder ?? null,
        selectedInstance: folderChanged
            ? (plan.selected.instance ?? null)
            : (plan.selected.instance ?? setting.selectedInstance ?? null),
        selectedAccount: plan.selected.account ?? setting.selectedAccount ?? null,
    };
    const nextAccounts: Accounts = {
        schemaVersion: accounts.schemaVersion,
        accounts: [...accounts.accounts, ...plan.accounts.added],
    };
    const probes: Record<string, ReturnType<typeof javaProbeOf>> = {};
    for (const item of addedJava) {
        probes[item.entry.path] = item.probe;
    }
    return { setting: nextSetting, accounts: nextAccounts, probes };
}

/* ---------- 定位 HMCL 数据目录 ---------- */

interface HmclHomes {
    readonly localHome: string | null;
    readonly userHome: string | null;
}

// local home 是 HMCL 工作目录下的 .hmcl（便携数据），user home 是按平台放的用户数据
// 两者的 config/ 文件名不同：local 是 game-directories.json / accounts.json，user 是 user-*.json
async function locateHomes(target: string): Promise<HmclHomes> {
    // 直接传 config/ 进来时退到它上一层
    const root = target.split(/[/\\]/).pop() === "config" ? resolve(target, "..") : target;

    let localHome: string | null = null;
    let userHome: string | null = null;
    if (await isLocalHome(root)) {
        localHome = root;
    }
    if (await isUserHome(root)) {
        userHome = root;
    }

    // user home 下的子目录可能放着一份 local home（如 local-stable/）
    if (userHome !== null) {
        for (const name of await subdirectories(userHome)) {
            const candidate = join(userHome, name);
            if (candidate !== localHome && (await isLocalHome(candidate))) {
                localHome = candidate;
                break;
            }
        }
    }

    // 反过来：传入的就是 local home，user home 在上一层
    if (localHome !== null && userHome === null) {
        const parent = resolve(localHome, "..");
        if (await isUserHome(parent)) {
            userHome = parent;
        }
    }
    return { localHome, userHome };
}

async function isLocalHome(directory: string): Promise<boolean> {
    const config = join(directory, "config");
    return (
        existsSync(join(config, "launcher-settings.json")) ||
        existsSync(join(config, "game-directories.json")) ||
        existsSync(join(config, "accounts.json"))
    );
}

async function isUserHome(directory: string): Promise<boolean> {
    const config = join(directory, "config");
    return (
        existsSync(join(config, "user-game-directories.json")) ||
        existsSync(join(config, "user-accounts.json")) ||
        existsSync(join(config, "user-settings.json"))
    );
}

async function subdirectories(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/* ---------- 自动探测 ---------- */

export type HmclHomeKind = "local" | "user";

export interface HmclCandidate {
    /** 交给 import 的目录 */
    readonly path: string;
    /** 相对路径的基准：目录名为 .hmcl（便携安装）取父目录，其余回退家目录 */
    readonly base: string;
    readonly kind: HmclHomeKind;
    /** config 里登记的游戏文件夹条数，不探测版本 */
    readonly folders: number;
    /** config 里登记的账号条数 */
    readonly accounts: number;
    /** 目录最后改动时间（毫秒），读不到给 null */
    readonly modified: number | null;
}

export interface HmclDetectOptions {
    /** 覆盖候选位置，测试用；不给就按平台取默认的那些 */
    readonly roots?: readonly string[];
}

/**
 * 找 HMCL 的数据目录
 *
 * 只看固定的几个位置，不递归扫盘：便携数据放在 HMCL 工作目录的 .hmcl，
 * 用户数据按平台放在固定位置。装在别处的只能手动把目录传给 import。
 */
export async function detectHmclHomes(options: HmclDetectOptions = {}): Promise<HmclCandidate[]> {
    const seen = new Set<string>();
    const found: HmclCandidate[] = [];
    for (const root of options.roots ?? candidateRoots()) {
        const path = resolve(expandHome(root));
        // Windows 的路径不区分大小写，两个根指到同一处时只留一个
        const key = platform === "Windows" ? path.toLowerCase() : path;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        if (await isLocalHome(path)) {
            found.push(await describe(path, "local"));
            continue;
        }
        if (await isUserHome(path)) {
            found.push(await describe(path, "user"));
        }
    }
    // 最近动过的排前面：同时装了几个 HMCL 时，常用的那个在最上面
    return found.sort(
        (left, right) =>
            (right.modified ?? 0) - (left.modified ?? 0) || left.path.localeCompare(right.path),
    );
}

async function describe(path: string, kind: HmclHomeKind): Promise<HmclCandidate> {
    const folders =
        (await readDirectories(path, "game-directories.json")).length +
        (await readDirectories(path, "user-game-directories.json")).length;
    const accounts =
        (await readAccounts(path, "accounts.json")).length +
        (await readAccounts(path, "user-accounts.json")).length;
    const modified = await stat(path)
        .then((info) => Math.round(info.mtimeMs))
        .catch(() => null);
    return {
        path,
        base: baseOf(path),
        kind,
        folders,
        accounts,
        modified,
    };
}

// 相对路径以 HMCL 的工作目录为准。只有数据目录本身就叫 .hmcl（便携安装）时，
// 它的父目录才等于工作目录；其它布局（如 ~/.local/share/hmcl/local-stable）推不出来，回退家目录
function baseOf(home: string): string {
    return basename(home) === ".hmcl" ? resolve(home, "..") : homedir();
}

function defaultBase(homes: HmclHomes): string {
    const home = homes.localHome ?? homes.userHome;
    return home === null ? homedir() : baseOf(home);
}

// 只扫系统盘与常见盘符：A、B 是软驱，X–Z 常被映射成网络驱动器，stat 可能卡住；
// 装在别的盘上只能手动把目录传给 import
const COMMON_DRIVE_LETTERS = ["C", "D", "E", "F", "G"];

function windowsDrives(): string[] {
    const letters = new Set<string>(COMMON_DRIVE_LETTERS);
    const system = process.env["SystemDrive"];
    if (system !== undefined && /^[A-Za-z]:$/.test(system)) {
        letters.add(system.slice(0, 1).toUpperCase());
    }
    return [...letters].sort();
}

function candidateRoots(): string[] {
    const home = homedir();
    switch (platform) {
        case "Windows": {
            const roots: string[] = [];
            for (const key of ["APPDATA", "LOCALAPPDATA"]) {
                const base = process.env[key];
                if (base === undefined || base === "") {
                    continue;
                }
                roots.push(join(base, ".hmcl"), join(base, "hmcl"));
            }
            roots.push(join(home, ".hmcl"), join(home, ".minecraft", ".hmcl"));
            // 便携版把 .hmcl 放在 HMCL 的工作目录，最常见的就是盘符根
            for (const drive of windowsDrives()) {
                roots.push(`${drive}:\\.hmcl`);
            }
            return roots;
        }
        case "macOS":
            return [
                join(home, "Library", "Application Support", "hmcl"),
                join(home, "Library", "Application Support", ".hmcl"),
                join(home, ".hmcl"),
            ];
        default: {
            const data = process.env["XDG_DATA_HOME"];
            const base = data === undefined || data === "" ? join(home, ".local", "share") : data;
            return [join(base, "hmcl"), join(home, ".hmcl")];
        }
    }
}

/* ---------- 文件夹 ---------- */

interface HmclDirectory {
    readonly id: string | null;
    readonly path: string;
    readonly name: string | null;
}

async function planFolders(
    setting: Setting,
    homes: HmclHomes,
    base: string,
): Promise<{
    plan: HmclImportPlan["folders"];
    /** HMCL 文件夹 id → Bloomery 文件夹 id */
    mapping: ReadonlyMap<string, string>;
}> {
    const listed: HmclDirectory[] = [];
    if (homes.localHome !== null) {
        listed.push(...(await readDirectories(homes.localHome, "game-directories.json")));
    }
    if (homes.userHome !== null) {
        listed.push(...(await readDirectories(homes.userHome, "user-game-directories.json")));
    }

    const existing = setting.folders.map((folder) => ({
        id: folder.id,
        path: resolveFolderPath(folder),
    }));
    const added: ImportedFolder[] = [];
    const skipped: SkippedFolder[] = [];
    const mapping = new Map<string, string>();
    const seen: string[] = [];

    for (const directory of listed) {
        const path = resolvePath(directory.path, base);
        if (path === null) {
            continue;
        }
        const duplicate = seen.find((item) => sameFolderPath(item, path)) !== undefined;
        seen.push(path);
        const known = existing.find((folder) => sameFolderPath(folder.path, path));
        if (known !== undefined) {
            skipped.push({ path, reason: "exists" });
            if (directory.id !== null) {
                mapping.set(directory.id, known.id);
            }
            continue;
        }
        if (duplicate) {
            continue;
        }
        const probe = await probeFolder(path);
        if (!probe.exists) {
            skipped.push({ path, reason: "not-found" });
            continue;
        }
        if (!probe.directory) {
            skipped.push({ path, reason: "not-directory" });
            continue;
        }
        const id = folderIdOf(probe.path, [
            ...existing.map((item) => item.id),
            ...added.map((item) => item.id),
        ]);
        const folder: Folder = {
            id,
            path: probe.path,
            autoDiscover: true,
            missingEntries: "keep",
            java: null,
            memory: null,
            instances: [],
        };
        added.push({ id, path: probe.path, versionCount: probe.versions, folder });
        if (directory.id !== null) {
            mapping.set(directory.id, id);
        }
    }

    return { plan: { added, skipped }, mapping };
}

async function readDirectories(home: string, file: string): Promise<HmclDirectory[]> {
    const data = await readJson(join(home, "config", file));
    if (data === undefined) {
        return [];
    }
    const rows = Array.isArray(data["directories"]) ? data["directories"] : [];
    const result: HmclDirectory[] = [];
    for (const row of rows) {
        if (!isRecord(row)) {
            continue;
        }
        const path = typeof row["path"] === "string" ? row["path"] : "";
        if (path === "") {
            continue;
        }
        result.push({
            id: typeof row["id"] === "string" ? row["id"] : null,
            path,
            name: typeof row["name"] === "string" ? row["name"] : null,
        });
    }
    return result;
}

/** 相对路径按 HMCL 的工作目录展开；空串给 null */
function resolvePath(path: string, base: string): string | null {
    const trimmed = path.trim();
    if (trimmed === "") {
        return null;
    }
    const expanded = expandHome(trimmed);
    const absolute = expanded.startsWith("/") || /^[A-Za-z]:[\\/]/.test(expanded);
    return resolve(absolute ? expanded : join(base, expanded));
}

/* ---------- Java ---------- */

async function planJava(
    setting: Setting,
    homes: HmclHomes,
    base: string,
): Promise<{ plan: HmclImportPlan["java"] }> {
    const candidates: string[] = [];
    for (const home of [homes.userHome, homes.localHome]) {
        if (home === null) {
            continue;
        }
        for (const file of ["javaCache.json", join("config", "javaCache.json")]) {
            for (const path of await readJavaCache(join(home, file))) {
                candidates.push(path);
            }
        }
    }
    // 新格式另有 userJava / disabledJava 两张表：手动添加的路径不从 javaCache 走
    if (homes.userHome !== null) {
        for (const path of await readUserJava(
            join(homes.userHome, "config", "user-settings.json"),
        )) {
            candidates.push(path);
        }
    }

    const added: ImportedJava[] = [];
    const skipped: SkippedJava[] = [];
    const known = setting.java.list.map((entry) => entry.path);
    for (const candidate of candidates) {
        const path = resolvePath(candidate, base);
        if (path === null) {
            continue;
        }
        if (known.some((item) => sameFolderPath(item, path))) {
            skipped.push({ path, reason: "duplicate" });
            continue;
        }
        if (!existsSync(path)) {
            skipped.push({ path, reason: "not-found" });
            continue;
        }
        const info = await probeJava(path, "detected");
        if (info === null) {
            skipped.push({ path, reason: "broken" });
            continue;
        }
        known.push(path);
        added.push({ entry: javaEntryOf(info), probe: javaProbeOf(info) });
    }
    return { plan: { added, skipped } };
}

/** user-settings.json 的 userJava 减 disabledJava；两张表的形状都是路径数组 */
async function readUserJava(path: string): Promise<string[]> {
    const data = await readJson(path);
    if (data === undefined) {
        return [];
    }
    const enabled = stringList(data["userJava"]);
    const disabled = new Set(stringList(data["disabledJava"]));
    return enabled.filter((item) => !disabled.has(item));
}

function stringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.filter((item): item is string => typeof item === "string" && item !== "");
}

async function readJavaCache(path: string): Promise<string[]> {
    const data = await readJson(path);
    if (data === undefined) {
        return [];
    }
    const rows = Array.isArray(data["caches"]) ? data["caches"] : [];
    const result: string[] = [];
    for (const row of rows) {
        if (isRecord(row) && typeof row["path"] === "string" && row["path"] !== "") {
            result.push(row["path"]);
        }
    }
    return result;
}

/* ---------- 账号 ---------- */

interface HmclAccount {
    readonly type: string;
    readonly id: string | null;
    readonly name: string | null;
    readonly profileId: string | null;
}

async function planAccounts(
    existing: Accounts,
    homes: HmclHomes,
    warnings: string[],
): Promise<{
    plan: HmclImportPlan["accounts"];
    /** HMCL accountID → Bloomery 账号 id */
    mapping: ReadonlyMap<string, string>;
}> {
    const listed: HmclAccount[] = [];
    if (homes.localHome !== null) {
        listed.push(...(await readAccounts(homes.localHome, "accounts.json")));
    }
    if (homes.userHome !== null) {
        listed.push(...(await readAccounts(homes.userHome, "user-accounts.json")));
    }

    const added: OfflineAccount[] = [];
    const skipped: SkippedAccount[] = [];
    const mapping = new Map<string, string>();
    const seen = new Set<string>();
    let credential = 0;
    let yggdrasil = 0;

    for (const account of listed) {
        const key = account.id ?? `${account.type}:${account.profileId ?? account.name ?? ""}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);

        if (account.type !== "offline") {
            if (account.type === "microsoft") {
                credential += 1;
            } else {
                yggdrasil += 1;
            }
            skipped.push({
                name: account.name ?? account.id ?? "未知账户",
                type: account.type,
                reason: account.type === "microsoft" ? "credential" : "yggdrasil",
            });
            continue;
        }
        if (account.name === null || account.name === "") {
            skipped.push({ name: account.id ?? "未知账户", type: account.type, reason: "unnamed" });
            continue;
        }
        const mapped = offlineAccount(account.name, account.profileId);
        if (existing.accounts.some((item) => item.id === mapped.id)) {
            skipped.push({ name: mapped.name, type: "offline", reason: "duplicate" });
            if (account.id !== null) {
                mapping.set(account.id, mapped.id);
            }
            continue;
        }
        added.push(mapped);
        if (account.id !== null) {
            mapping.set(account.id, mapped.id);
        }
    }

    if (credential > 0) {
        warnings.push("HMCL 的微软账号凭据是加密存储，未迁移；导入后需要在 GUI 重新登录微软账号");
    }
    if (yggdrasil > 0) {
        warnings.push("HMCL 的外置登录（authlib-injector）账号未迁移，Bloomery 暂不支持该登录方式");
    }
    return { plan: { added, skipped }, mapping };
}

async function readAccounts(home: string, file: string): Promise<HmclAccount[]> {
    const data = await readJson(join(home, "config", file));
    if (data === undefined) {
        return [];
    }
    const rows = Array.isArray(data["accounts"]) ? data["accounts"] : [];
    const result: HmclAccount[] = [];
    for (const row of rows) {
        if (!isRecord(row)) {
            continue;
        }
        const type = typeof row["type"] === "string" ? row["type"] : "";
        if (type === "") {
            continue;
        }
        result.push({
            type,
            id: typeof row["accountID"] === "string" ? row["accountID"] : null,
            name: typeof row["profileName"] === "string" ? row["profileName"] : null,
            profileId: typeof row["profileID"] === "string" ? row["profileID"] : null,
        });
    }
    return result;
}

/* ---------- 选中状态 ---------- */

async function planSelection(
    setting: Setting,
    homes: HmclHomes,
    folders: {
        plan: HmclImportPlan["folders"];
        mapping: ReadonlyMap<string, string>;
    },
    accounts: {
        plan: HmclImportPlan["accounts"];
        mapping: ReadonlyMap<string, string>;
    },
): Promise<HmclSelection> {
    const launcher =
        homes.localHome === null ? undefined : await readLauncherSettings(homes.localHome);

    // HMCL 的 selectedInstance 是「文件夹 id → 实例 id」的表
    const selectedDirectoryId =
        launcher !== undefined && typeof launcher["selectedGameDirectory"] === "string"
            ? launcher["selectedGameDirectory"]
            : null;
    let folderId =
        selectedDirectoryId === null ? null : (folders.mapping.get(selectedDirectoryId) ?? null);
    if (folderId === null) {
        folderId = folders.plan.added[0]?.id ?? null;
    }

    let instanceId: string | null = null;
    if (folderId !== null) {
        const map = launcher === undefined ? undefined : launcher["selectedInstance"];
        const wanted =
            isRecord(map) &&
            selectedDirectoryId !== null &&
            typeof map[selectedDirectoryId] === "string"
                ? (map[selectedDirectoryId] as string)
                : null;
        const folder = folderOf(folderId, setting, folders.plan);
        if (watched(wanted) && folder !== undefined) {
            const view = await readFolder(folder);
            if (view.instances.some((item) => item.id === wanted)) {
                instanceId = wanted;
            }
        }
    }

    let accountId: string | null = null;
    const selectedAccount =
        launcher !== undefined && typeof launcher["selectedAccount"] === "string"
            ? launcher["selectedAccount"]
            : null;
    if (selectedAccount !== null) {
        accountId = accounts.mapping.get(selectedAccount) ?? null;
    }
    if (accountId === null && (setting.selectedAccount ?? null) === null) {
        accountId = accounts.plan.added[0]?.id ?? null;
    }

    return { folder: folderId, instance: instanceId, account: accountId };
}

function folderOf(
    id: string,
    setting: Setting,
    plan: HmclImportPlan["folders"],
): Folder | undefined {
    const added = plan.added.find((item) => item.id === id);
    if (added !== undefined) {
        return added.folder;
    }
    return setting.folders.find((item) => item.id === id);
}

function watched(value: string | null): value is string {
    return value !== null && value !== "";
}

/* ---------- 读文件 ---------- */

/** local home 的 config/launcher-settings.json：选中文件夹、选中实例表与选中账号 */
async function readLauncherSettings(home: string): Promise<Record<string, unknown> | undefined> {
    return readJson(join(home, "config", "launcher-settings.json"));
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
    const text = await readText(path);
    if (text === undefined) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return isRecord(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
