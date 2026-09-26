/*
 * 设置文件
 *
 * 读入宽容：坏字段落默认值；坏文件与出现未知键时先把原文件留一份
 * schemaVersion 比程序新时不迁移、不写回，本次运行只读
 */

import { AppError } from "../error/index.ts";
import { backupFile, readText, writeAtomic } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import { settingFile } from "../platform/index.ts";
import { defaultSetting } from "./defaults.ts";
import { migrate, versionOf } from "./migrate.ts";
import { object, parseJson, reader, type Reader } from "./read.ts";
import {
    CURRENT_SCHEMA,
    type Appearance,
    type CleanupSetting,
    type DownloadSetting,
    type Folder,
    type Instance,
    type JavaEntry,
    type JavaSetting,
    type LaunchSetting,
    type Loader,
    type LogSetting,
    type MemoryPatch,
    type ModSetting,
    type Network,
    type Setting,
    type UseGlobalSettings,
    type Window,
} from "./types.ts";

const log = logger("config");

const LOADERS = ["vanilla", "fabric", "forge", "neoforge", "quilt"] as const;
const SWITCHES = ["isolation", "java", "memory", "window", "jvmArgs", "gameArgs"] as const;

let readOnly = false;

// 配置比程序新时为 true：本次运行用默认值，且禁止写回
export function settingReadOnly(): boolean {
    return readOnly;
}

export async function loadSetting(): Promise<Setting> {
    const path = settingFile();
    const text = await readText(path);
    if (text === undefined) {
        readOnly = false;
        return defaultSetting();
    }

    const parsed = object(parseJson(text, path), path);
    if (parsed === undefined) {
        const kept = await backupFile(path, true);
        log.warn("%s 读不出来，已挪到 %s，本次用默认值", path, kept ?? "(备份失败)");
        readOnly = false;
        return defaultSetting();
    }

    const version = versionOf(parsed);
    if (version > CURRENT_SCHEMA) {
        readOnly = true;
        log.warn("%s 是格式版本 %d，程序只认到 %d，本次运行不写回", path, version, CURRENT_SCHEMA);
        return defaultSetting();
    }

    const extras: string[] = [];
    const setting = readSetting(migrate(parsed, version), extras);
    readOnly = false;

    if (extras.length > 0) {
        const kept = await backupFile(path);
        log.warn(
            "%s 里有不认识的键，已丢弃并在 %s 留了一份：%s",
            path,
            kept ?? "(备份失败)",
            extras.join(", "),
        );
        await saveSetting(setting);
    }
    return setting;
}

export async function saveSetting(setting: Setting): Promise<void> {
    if (readOnly) {
        throw new AppError("config", "ConfigTooNew", { context: { detail: settingFile() } });
    }
    await writeAtomic(settingFile(), `${JSON.stringify(setting, null, 4)}\n`);
}

// 字段顺序与 schema 一致，写出的 JSON 才有稳定的键序
function readSetting(raw: Record<string, unknown>, extras: string[]): Setting {
    const base = defaultSetting();
    const r = reader("setting", raw, extras);

    const appearance = r.object("appearance");
    const logSetting = r.object("log");
    const network = r.object("network");
    const download = r.object("download");
    const java = r.object("java");
    const launch = r.object("launch");
    const mod = r.object("mod");
    const cleanup = r.object("cleanup");

    const setting: Setting = {
        schemaVersion: CURRENT_SCHEMA,
        language: r.string("language", base.language),
        appearance: readAppearance(appearance, base.appearance),
        log: readLog(logSetting, base.log),
        network: readNetwork(network, base.network),
        download: readDownload(download, base.download, extras),
        java: readJava(java, base.java, extras),
        launch: readLaunch(launch, base.launch),
        mod: readMod(mod, base.mod),
        cleanup: readCleanup(cleanup, base.cleanup),
        selectedAccount: r.nullableString("selectedAccount", base.selectedAccount ?? null),
        selectedFolder: r.nullableString("selectedFolder", base.selectedFolder ?? null),
        folders: r.list<Folder>("folders", base.folders, (value, at) =>
            readFolder(value, at, extras),
        ),
    };

    for (const sub of [appearance, logSetting, network, download, java, launch, mod, cleanup]) {
        sub?.extra();
    }
    r.extra();
    return setting;
}

// 子对象缺失或不是对象时整块用默认值
function from<T>(sub: Reader | undefined, fallback: T, read: (s: Reader) => T): T {
    return sub === undefined ? fallback : read(sub);
}

function readAppearance(s: Reader | undefined, base: Appearance): Appearance {
    return from(s, base, (sub) => ({
        color: sub.enumeration("color", ["auto", "always", "never"], base.color),
        unicode: sub.boolean("unicode", base.unicode),
        progress: sub.enumeration("progress", ["bar", "plain", "off"], base.progress),
    }));
}

function readLog(s: Reader | undefined, base: LogSetting): LogSetting {
    return from(s, base, (sub) => ({
        enabled: sub.boolean("enabled", base.enabled),
        level: sub.enumeration(
            "level",
            ["debug", "info", "warning", "error", "silent"],
            base.level,
        ),
        directory: sub.nullableString("directory", base.directory ?? null),
        keep: sub.integer("keep", base.keep, Number.MIN_SAFE_INTEGER),
    }));
}

function readNetwork(s: Reader | undefined, base: Network): Network {
    return from(s, base, (sub) => ({
        proxy: sub.nullableString("proxy", base.proxy ?? null),
        noProxy: sub.list<string>("noProxy", base.noProxy, stringItem),
        timeoutMs: sub.integer("timeoutMs", base.timeoutMs, 1000),
        retries: sub.integer("retries", base.retries, 0),
        concurrency: sub.integer("concurrency", base.concurrency, 1),
    }));
}

function readDownload(
    s: Reader | undefined,
    base: DownloadSetting,
    extras: string[],
): DownloadSetting {
    return from(s, base, (sub) => ({
        verify: sub.enumeration("verify", ["strict", "warn", "off"], base.verify),
        sources: sub.list("sources", base.sources, (value, at) => {
            const one = object(value, at);
            if (one === undefined) {
                return undefined;
            }
            const item = reader(at, one, extras);
            const source = {
                provider: item.enumeration(
                    "provider",
                    ["official", "bmclapi", "custom"],
                    "official",
                ),
                enabled: item.boolean("enabled", true),
                url: item.nullableString("url", null),
            };
            item.extra();
            return source;
        }),
    }));
}

function readJava(s: Reader | undefined, base: JavaSetting, extras: string[]): JavaSetting {
    return from(s, base, (sub) => ({
        autoDetect: sub.boolean("autoDetect", base.autoDetect),
        autoDownload: sub.boolean("autoDownload", base.autoDownload),
        runtimeDirectory: sub.nullableString("runtimeDirectory", base.runtimeDirectory ?? null),
        list: sub.list<JavaEntry>("list", base.list, (value, at) => {
            const one = object(value, at);
            if (one === undefined) {
                return undefined;
            }
            const item = reader(at, one, extras);
            const path = item.string("path", "");
            if (path === "") {
                log.warn("%s 缺 path，已忽略这条", at);
                item.extra();
                return undefined;
            }
            const entry: JavaEntry = {
                path,
                major: item.optionalInteger("major", 1) ?? null,
                kind: item.enumeration("kind", ["jdk", "jre"], "jdk"),
                arch: item.enumeration("arch", ["x64", "x86", "arm64", "arm"] as const, "x64"),
                vendor: item.nullableString("vendor", null),
                source: item.enumeration(
                    "source",
                    ["manual", "detected", "downloaded"],
                    "detected",
                ),
            };
            item.extra();
            return entry;
        }),
    }));
}

function readLaunch(s: Reader | undefined, base: LaunchSetting): LaunchSetting {
    return from(s, base, (sub) => {
        const memory = sub.object("memory");
        const window = sub.object("window");
        return {
            memory: from(memory, base.memory, (m) => ({
                minMb: m.integer("minMb", base.memory.minMb, 128),
                maxMb: m.integer("maxMb", base.memory.maxMb, 512),
            })),
            window: from(window, base.window, (w) => ({
                width: w.integer("width", base.window.width, 320),
                height: w.integer("height", base.window.height, 240),
                fullscreen: w.boolean("fullscreen", base.window.fullscreen),
            })),
            jvmArgs: sub.list<string>("jvmArgs", base.jvmArgs, stringItem),
            gameArgs: sub.list<string>("gameArgs", base.gameArgs, stringItem),
            waitForExit: sub.boolean("waitForExit", base.waitForExit),
        };
    });
}

function readMod(s: Reader | undefined, base: ModSetting): ModSetting {
    return from(s, base, (sub) => ({
        provider: sub.enumeration("provider", ["modrinth", "curseforge"], base.provider),
        installDependencies: sub.boolean("installDependencies", base.installDependencies),
    }));
}

function readCleanup(s: Reader | undefined, base: CleanupSetting): CleanupSetting {
    return from(s, base, (sub) => ({
        orphan: sub.enumeration("orphan", ["ask", "auto", "never"], base.orphan),
    }));
}

function readFolder(value: unknown, at: string, extras: string[]): Folder | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, extras);
    const id = r.string("id", "");
    const path = r.string("path", "");
    if (id === "" || path === "") {
        log.warn("%s 缺 id 或 path，已忽略这个文件夹", at);
        r.extra();
        return undefined;
    }
    const memory = r.object("memory");
    const folder: Folder = {
        id,
        name: r.string("name", id),
        path,
        isolation: r.boolean("isolation", false),
        autoDiscover: r.boolean("autoDiscover", true),
        missingEntries: r.enumeration("missingEntries", ["keep", "drop"], "keep"),
        java: r.nullableString("java", null),
        memory: memory === undefined ? null : readMemoryPatch(memory),
        instances: r.list<Instance>("instances", [], (item, where) =>
            readInstance(item, where, extras),
        ),
    };
    r.extra();
    return folder;
}

function readInstance(value: unknown, at: string, extras: string[]): Instance | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, extras);
    const id = r.string("id", "");
    const target = r.string("target", "");
    if (id === "" || target === "") {
        log.warn("%s 缺 id 或 target，已忽略这个实例", at);
        r.extra();
        return undefined;
    }
    const loader = r.object("loader");
    const switches = r.object("useGlobalSettings");
    const memory = r.object("memory");
    const window = r.object("window");
    const instance: Instance = {
        id,
        name: r.string("name", id),
        target,
        loader: readLoader(loader),
        useGlobalSettings: readSwitches(switches),
        isolation: r.optionalBoolean("isolation") ?? null,
        java: r.nullableString("java", null),
        memory: memory === undefined ? null : readMemoryPatch(memory),
        jvmArgs: r.list<string>("jvmArgs", [], stringItem),
        gameArgs: r.list<string>("gameArgs", [], stringItem),
        window: window === undefined ? null : readWindow(window),
        notes: r.nullableString("notes", null),
    };
    r.extra();
    return instance;
}

function readLoader(s: Reader | undefined): Loader {
    if (s === undefined) {
        return { type: "vanilla", version: null };
    }
    const type = s.enumeration("type", LOADERS, "vanilla");
    const version = s.nullableString("version", null);
    s.extra();
    return { type, version: type === "vanilla" ? null : version };
}

function readSwitches(s: Reader | undefined): UseGlobalSettings {
    if (s === undefined) {
        return {};
    }
    const switches: Record<string, boolean> = {};
    for (const key of SWITCHES) {
        const value = s.optionalBoolean(key);
        if (value !== undefined) {
            switches[key] = value;
        }
    }
    s.extra();
    return switches;
}

function readMemoryPatch(s: Reader): MemoryPatch | null {
    const minMb = s.optionalInteger("minMb", 128);
    const maxMb = s.optionalInteger("maxMb", 512);
    s.extra();
    if (minMb === undefined && maxMb === undefined) {
        return null;
    }
    return {
        ...(minMb === undefined ? {} : { minMb }),
        ...(maxMb === undefined ? {} : { maxMb }),
    };
}

function readWindow(s: Reader): Window {
    const window: Window = {
        width: s.integer("width", 854, 320),
        height: s.integer("height", 480, 240),
        fullscreen: s.boolean("fullscreen", false),
    };
    s.extra();
    return window;
}

function stringItem(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}
