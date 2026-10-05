/**
 * config 命令：按点分路径读写 setting.json
 *
 * 可写的键在 defaults.ts 的默认值上推导，另加 folders / instances 两段按 id 走的动态键
 * 值先按 JSON 字面量认，认不出当普通字符串，--string 强制当字符串
 * 别的命令管着的键在这里读写都报用法错误，避免两条写路径
 * @author IsCibocaz
 * @since 1.12.0
 */

import { defaultSetting, loadSetting, saveSetting } from "../../config/index.ts";
import type { Folder, Instance, Setting } from "../../config/types.ts";
import { AppError } from "../../error/index.ts";
import { print, versioned } from "../../output/index.ts";
import { readFolder } from "../../version/index.ts";
import type { ConfigCommand, Context } from "../parse.ts";

type Kind = "string" | "nullableString" | "number" | "boolean" | "stringArray" | "enum";

interface Field {
    readonly kind: Kind;
    readonly values?: readonly string[];
}

const LABEL: Readonly<Record<Kind, string>> = {
    string: "字符串",
    nullableString: "字符串或 null",
    number: "整数",
    boolean: "true 或 false",
    stringArray: "字符串数组",
    enum: "取值之一",
};

// 枚举键的取值来自类型定义
const ENUMS: Readonly<Record<string, readonly string[]>> = {
    "appearance.color": ["auto", "always", "never"],
    "appearance.progress": ["bar", "plain", "off"],
    "log.level": ["debug", "info", "warning", "error", "silent"],
    "download.verify": ["strict", "warn", "off"],
    "mod.provider": ["modrinth", "curseforge"],
    "cleanup.orphan": ["ask", "auto", "never"],
};

// 由别的命令维护的键，报错时指向对应入口
const OWNED: Readonly<Record<string, string>> = {
    selectedAccount: "auth login / auth logout",
    selectedFolder: "folder select",
    selectedInstance: "version select",
    "java.list": "java add / java remove / java scan",
    "download.sources": "mirror use",
};

const FOLDER_FIELDS: Readonly<Record<string, Field>> = {
    name: { kind: "string" },
    java: { kind: "nullableString" },
    "memory.minMb": { kind: "number" },
    "memory.maxMb": { kind: "number" },
};

const INSTANCE_FIELDS: Readonly<Record<string, Field>> = {
    name: { kind: "string" },
    java: { kind: "nullableString" },
    notes: { kind: "nullableString" },
    "memory.minMb": { kind: "number" },
    "memory.maxMb": { kind: "number" },
    "window.width": { kind: "number" },
    "window.height": { kind: "number" },
    "window.fullscreen": { kind: "boolean" },
    "useGlobalSettings.java": { kind: "boolean" },
    "useGlobalSettings.memory": { kind: "boolean" },
    "useGlobalSettings.window": { kind: "boolean" },
    "useGlobalSettings.jvmArgs": { kind: "boolean" },
    "useGlobalSettings.gameArgs": { kind: "boolean" },
    jvmArgs: { kind: "stringArray" },
    gameArgs: { kind: "stringArray" },
};

export async function runConfig(command: ConfigCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const scope = scopeOf(command);

    if (command.action === "get") {
        const key = command.key ?? "";
        // 没有作用域时不给键就是整份配置；给了作用域拿该条目
        if (key === "" && scope.folder === undefined) {
            print(
                ctx.json
                    ? JSON.stringify(versioned({ config: setting }), null, 4)
                    : JSON.stringify(setting, null, 4),
            );
            return;
        }
        const target = await resolve(key, setting, scope);
        show(target, pathRead(setting, target.segments) ?? null, ctx);
        return;
    }

    const target = await resolve(requireKey(command), setting, scope);
    if (target.field === null) {
        throw new AppError("cli", "UsageError", { context: { detail: "缺少参数 <键>" } });
    }

    if (command.action === "set") {
        const raw = command.value;
        if (raw === undefined) {
            throw new AppError("cli", "UsageError", { context: { detail: "set 缺少参数 <值>" } });
        }
        const value = coerce(raw, target.field, command.asString === true);
        await saveSetting(assign(setting, target.segments, value, target.seeds));
        show(target, value, ctx);
        return;
    }

    const next = unsetKey(setting, target);
    await saveSetting(next);
    show(target, pathRead(next, target.segments) ?? null, ctx);
}

// 输出里 key 是作用域内的键，文件夹与实例另给，含点号的 id 才不会歧义
function show(target: Target, value: unknown, ctx: Context): void {
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned({
                    key: target.key === "" ? null : target.key,
                    folder: target.folder,
                    instance: target.instance,
                    value,
                }),
                null,
                4,
            ),
        );
        return;
    }
    print(`${label(target)} = ${typeof value === "string" ? value : JSON.stringify(value)}`);
}

function label(target: Target): string {
    if (target.instance !== null) {
        return `${target.key}（实例 ${target.instance} @ ${target.folder ?? ""}）`;
    }
    if (target.folder !== null) {
        return `${target.key}（文件夹 ${target.folder}）`;
    }
    return target.key;
}

/* ---------- 键 ---------- */

function requireKey(command: ConfigCommand): string {
    if (command.key === undefined || command.key === "") {
        throw new AppError("cli", "UsageError", {
            context: { detail: `${command.action} 缺少参数 <键>` },
        });
    }
    return command.key;
}

interface Scope {
    readonly folder?: string | undefined;
    readonly instance?: string | undefined;
}

function scopeOf(command: ConfigCommand): Scope {
    if (command.instance !== undefined && command.folder === undefined) {
        throw new AppError("cli", "UsageError", {
            context: { detail: "--instance 要配 --folder：实例 id 只在文件夹内唯一" },
        });
    }
    return { folder: command.folder, instance: command.instance };
}

function segmentsOf(key: string): readonly string[] {
    return key.split(".");
}

// 路径上按 id 找元素的位置：folders.<文件夹 id> 与 folders.<id>.instances.<实例 id>
function idAt(segments: readonly string[], index: number): "folders" | "instances" | null {
    if (index === 1 && segments[0] === "folders") {
        return "folders";
    }
    if (index === 3 && segments[0] === "folders" && segments[2] === "instances") {
        return "instances";
    }
    return null;
}

interface Target {
    /** null 表示作用域本身，只有 get 不带键时才出现 */
    readonly field: Field | null;
    readonly segments: readonly string[];
    /** 写动态键时补的新条目，键是路径上的下标 */
    readonly seeds: ReadonlyMap<number, Record<string, unknown>>;
    /** 作用是域内的键；全局键就是键本身 */
    readonly key: string;
    readonly folder: string | null;
    readonly instance: string | null;
}

const NO_SEEDS: ReadonlyMap<number, Record<string, unknown>> = new Map();

async function resolve(key: string, setting: Setting, scope: Scope): Promise<Target> {
    if (scope.folder === undefined) {
        return resolveGlobal(key, setting);
    }
    // id 放在 --folder / --instance 里，路径就不再按点号切 id
    if (key.startsWith("folders.")) {
        throw new AppError("cli", "UsageError", {
            context: { detail: "给了 --folder / --instance 时键要相对该作用域，例如 memory.maxMb" },
        });
    }

    const folder = setting.folders.find((item) => item.id === scope.folder);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", { context: { detail: scope.folder } });
    }

    if (scope.instance === undefined) {
        const segments =
            key === "" ? ["folders", folder.id] : ["folders", folder.id, ...segmentsOf(key)];
        const field = key === "" ? null : (FOLDER_FIELDS[key] ?? null);
        if (key !== "" && field === null) {
            throw unknownKey(key, "文件夹级");
        }
        return { field, segments, seeds: NO_SEEDS, key, folder: folder.id, instance: null };
    }

    const id = scope.instance;
    const segments =
        key === ""
            ? ["folders", folder.id, "instances", id]
            : ["folders", folder.id, "instances", id, ...segmentsOf(key)];
    const field = key === "" ? null : (INSTANCE_FIELDS[key] ?? null);
    if (key !== "" && field === null) {
        throw unknownKey(key, "实例级");
    }
    return {
        field,
        segments,
        seeds: await seedFor(folder, id),
        key,
        folder: folder.id,
        instance: id,
    };
}

// 配置里没有这条实例时按磁盘上的版本补一条，覆盖项才有地方落
async function seedFor(
    folder: Folder,
    id: string,
): Promise<ReadonlyMap<number, Record<string, unknown>>> {
    if (folder.instances.some((item) => item.id === id)) {
        return NO_SEEDS;
    }
    const view = await readFolder(folder);
    const found = view.instances.find((item) => item.id === id);
    if (found === undefined) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: id, folder: folder.id },
        });
    }
    const seed: Instance = {
        id,
        target: found.target,
        loader: found.loader,
        jvmArgs: [],
        gameArgs: [],
    };
    return new Map([[3, seed as unknown as Record<string, unknown>]]);
}

// 点分写法：静态键走默认值表，id 里没有点号时也能寻址文件夹与实例
async function resolveGlobal(key: string, setting: Setting): Promise<Target> {
    const segments = segmentsOf(key);
    const owned = OWNED[key];
    if (owned !== undefined) {
        throw new AppError("cli", "UsageError", {
            context: { detail: `${key} 由 ${owned} 管` },
        });
    }

    if (segments[0] !== "folders") {
        const field = staticFields().get(key);
        if (field === undefined) {
            throw unknownKey(key);
        }
        return { field, segments, seeds: NO_SEEDS, key, folder: null, instance: null };
    }

    if (segments[2] === "instances") {
        const folder = folderOf(setting, segments[1]);
        const id = segments[3] ?? "";
        const field = INSTANCE_FIELDS[segments.slice(4).join(".")];
        if (field === undefined) {
            throw unknownKey(key, "实例级");
        }
        return {
            field,
            segments,
            seeds: await seedFor(folder, id),
            key: segments.slice(4).join("."),
            folder: folder.id,
            instance: id,
        };
    }

    const folder = folderOf(setting, segments[1]);
    const field = FOLDER_FIELDS[segments.slice(2).join(".")];
    if (field === undefined) {
        throw unknownKey(key, "文件夹级");
    }
    return {
        field,
        segments,
        seeds: NO_SEEDS,
        key: segments.slice(2).join("."),
        folder: folder.id,
        instance: null,
    };
}

function folderOf(setting: Setting, id: string | undefined): Folder {
    const folder = setting.folders.find((item) => item.id === id);
    if (folder === undefined) {
        throw new AppError("cli", "FolderNotFound", { context: { detail: id ?? "" } });
    }
    return folder;
}

// 含点号的键要改用 --folder / --instance，报错里说清楚
function unknownKey(key: string, scope?: string): AppError {
    const where = scope === undefined ? "" : `（${scope}）`;
    const hint =
        key.includes(".") && scope !== undefined ? "；含点号的 id 用 --folder / --instance" : "";
    return new AppError("cli", "UsageError", {
        context: { detail: `未知的配置键 ${key}${where}${hint}` },
    });
}

// 默认值里能走到的叶子都可写；数组只认字符串数组，其余数组另有命令管
function staticFields(): ReadonlyMap<string, Field> {
    if (CACHE.fields !== undefined) {
        return CACHE.fields;
    }
    const fields = new Map<string, Field>();
    walk("", defaultSetting() as unknown as Record<string, unknown>, fields);
    for (const [path, values] of Object.entries(ENUMS)) {
        fields.set(path, { kind: "enum", values });
    }
    CACHE.fields = fields;
    return fields;
}

const CACHE: { fields?: Map<string, Field> } = {};

function walk(prefix: string, value: unknown, fields: Map<string, Field>): void {
    if (prefix !== "" && ownedBelow(prefix)) {
        return;
    }
    if (Array.isArray(value)) {
        if (prefix !== "" && value.every((item) => typeof item === "string")) {
            fields.set(prefix, { kind: "stringArray" });
        }
        return;
    }
    if (value !== null && typeof value === "object") {
        for (const [key, item] of Object.entries(value)) {
            walk(prefix === "" ? key : `${prefix}.${key}`, item, fields);
        }
        return;
    }
    // schemaVersion 不是给人改的
    if (prefix === "" || prefix === "schemaVersion") {
        return;
    }
    const field = leafOf(value);
    if (field !== null) {
        fields.set(prefix, field);
    }
}

function ownedBelow(path: string): boolean {
    return Object.keys(OWNED).some((key) => path === key || path.startsWith(`${key}.`));
}

function leafOf(value: unknown): Field | null {
    if (value === null) {
        return { kind: "nullableString" };
    }
    if (typeof value === "string") {
        return { kind: "string" };
    }
    if (typeof value === "number") {
        return { kind: "number" };
    }
    if (typeof value === "boolean") {
        return { kind: "boolean" };
    }
    return null;
}

/* ---------- 值 ---------- */

function coerce(raw: string, field: Field, asString: boolean): unknown {
    const value = asString ? raw : literal(raw);
    if (matches(value, field)) {
        return value;
    }
    const expected = field.kind === "enum" ? (field.values ?? []).join(" / ") : LABEL[field.kind];
    throw new AppError("cli", "UsageError", {
        context: { detail: `${expected}：${raw}` },
    });
}

function matches(value: unknown, field: Field): boolean {
    switch (field.kind) {
        case "string":
            return typeof value === "string";
        case "nullableString":
            return value === null || typeof value === "string";
        case "number":
            return typeof value === "number" && Number.isInteger(value);
        case "boolean":
            return typeof value === "boolean";
        case "stringArray":
            return Array.isArray(value) && value.every((item) => typeof item === "string");
        case "enum":
            return typeof value === "string" && (field.values ?? []).includes(value);
    }
}

// 像 JSON 就按 JSON 认，认不出当字符串
function literal(raw: string): unknown {
    try {
        return JSON.parse(raw) as unknown;
    } catch {
        return raw;
    }
}

/* ---------- 读写 ---------- */

function pathRead(root: unknown, segments: readonly string[]): unknown {
    let cursor: unknown = root;
    for (const [index, segment] of segments.entries()) {
        cursor = step(cursor, segment, idAt(segments, index));
        if (cursor === undefined) {
            return undefined;
        }
    }
    return cursor;
}

function step(cursor: unknown, segment: string, at: "folders" | "instances" | null): unknown {
    if (at !== null) {
        if (!Array.isArray(cursor)) {
            return undefined;
        }
        return cursor.find((item) => (item as { id?: string }).id === segment);
    }
    if (cursor === null || typeof cursor !== "object") {
        return undefined;
    }
    return (cursor as Record<string, unknown>)[segment];
}

function assign(
    setting: Setting,
    segments: readonly string[],
    value: unknown,
    seeds: ReadonlyMap<number, Record<string, unknown>> = NO_SEEDS,
): Setting {
    return write(
        setting as unknown as Record<string, unknown>,
        segments,
        0,
        value,
        seeds,
    ) as unknown as Setting;
}

function write(
    cursor: Record<string, unknown> | readonly unknown[],
    segments: readonly string[],
    index: number,
    value: unknown,
    seeds: ReadonlyMap<number, Record<string, unknown>>,
): Record<string, unknown> | readonly unknown[] {
    const segment = segments[index] ?? "";
    const at = idAt(segments, index);
    const last = index === segments.length - 1;

    if (at !== null) {
        const list = [...(cursor as readonly unknown[])];
        const found = list.findIndex((item) => (item as { id?: string }).id === segment);
        // 配置里还没有这条时追加，resolve 保证这种情形带种子
        const position = found < 0 ? list.length : found;
        const element = (list[position] ?? seeds.get(index) ?? {}) as Record<string, unknown>;
        list[position] = last ? element : write(element, segments, index + 1, value, seeds);
        return list;
    }

    const record = { ...(cursor as Record<string, unknown>) };
    record[segment] = last
        ? value
        : write(
              (record[segment] ?? {}) as Record<string, unknown>,
              segments,
              index + 1,
              value,
              seeds,
          );
    return record;
}

// 静态键回到默认值；动态键把这一项删掉
function unsetKey(setting: Setting, target: Target): Setting {
    const fallback = staticDefault(target.segments);
    return fallback === MISSING
        ? drop(setting, target.segments)
        : assign(setting, target.segments, fallback);
}

const MISSING = Symbol("missing");

function staticDefault(segments: readonly string[]): unknown {
    let cursor: unknown = defaultSetting();
    for (const [index, segment] of segments.entries()) {
        if (idAt(segments, index) !== null) {
            return MISSING;
        }
        if (cursor === null || typeof cursor !== "object") {
            return MISSING;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
    }
    return cursor === undefined ? MISSING : cursor;
}

function drop(setting: Setting, segments: readonly string[]): Setting {
    return remove(setting as unknown as Record<string, unknown>, segments, 0) as unknown as Setting;
}

function remove(
    cursor: Record<string, unknown> | readonly unknown[],
    segments: readonly string[],
    index: number,
): Record<string, unknown> | readonly unknown[] {
    const segment = segments[index] ?? "";
    const at = idAt(segments, index);
    const last = index === segments.length - 1;

    if (at !== null) {
        const list = [...(cursor as readonly unknown[])];
        const position = list.findIndex((item) => (item as { id?: string }).id === segment);
        if (position < 0) {
            return list;
        }
        if (!last) {
            list[position] = remove(
                (list[position] ?? {}) as Record<string, unknown>,
                segments,
                index + 1,
            );
        }
        return list;
    }

    const record = { ...(cursor as Record<string, unknown>) };
    if (last) {
        delete record[segment];
        return record;
    }
    const child = remove((record[segment] ?? {}) as Record<string, unknown>, segments, index + 1);
    // 补丁删空之后置 null，读配置的人少判断一种形状
    record[segment] = isEmptyPatch(child) ? null : child;
    return record;
}

function isEmptyPatch(value: unknown): boolean {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).length === 0
    );
}
