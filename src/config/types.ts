/*
 * 配置文件的类型
 *
 * 与 schema/*.schema.json 一一对应，两边的同步由 test 守住
 * 字段顺序按 schema 来：写出时 JSON.stringify 保留插入顺序，diff 才稳定
 */

import type { LogLevel } from "../output/index.ts";

/** 当前格式版本，写出的文件都是这个值 */
export const CURRENT_SCHEMA = 1;

export type ConfigLogLevel = "debug" | "info" | "warning" | "error" | "silent";

// 配置里的小写级别映射到输出层的类型
export function toLogLevel(level: ConfigLogLevel): LogLevel {
    switch (level) {
        case "debug":
            return "Debug";
        case "info":
            return "Info";
        case "warning":
            return "Warning";
        case "error":
            return "Error";
        default:
            return "Silent";
    }
}

/* ---------- setting ---------- */

export interface Memory {
    readonly minMb: number;
    readonly maxMb: number;
}

/** 只写要覆盖的键，其余跟随上层 */
export interface MemoryPatch {
    readonly minMb?: number;
    readonly maxMb?: number;
}

export interface Window {
    readonly width: number;
    readonly height: number;
    readonly fullscreen: boolean;
}

export type LoaderType = "vanilla" | "fabric" | "forge" | "neoforge" | "quilt";

export interface Loader {
    readonly type: LoaderType;
    /** vanilla 时为 null */
    readonly version?: string | null;
}

export type JavaKind = "jdk" | "jre";
export type JavaArch = "x64" | "x86" | "arm64" | "arm";
/** manual 是用户指定的，坏了要报；detected 是扫描缓存，坏了可以静默重扫 */
export type JavaSource = "manual" | "detected" | "downloaded";

export interface JavaEntry {
    readonly path: string;
    readonly major?: number | null;
    readonly kind: JavaKind;
    readonly arch?: JavaArch | null;
    readonly vendor?: string | null;
    readonly source: JavaSource;
}

export interface JavaSetting {
    readonly autoDetect: boolean;
    readonly autoDownload: boolean;
    readonly runtimeDirectory?: string | null;
    readonly list: readonly JavaEntry[];
}

export type DownloadProvider = "official" | "bmclapi" | "custom";

export interface DownloadSource {
    readonly provider: DownloadProvider;
    readonly enabled: boolean;
    /** custom 时的根地址，其余留 null 用内置地址 */
    readonly url?: string | null;
}

export interface Network {
    readonly proxy?: string | null;
    readonly noProxy: readonly string[];
    readonly timeoutMs: number;
    readonly retries: number;
    readonly concurrency: number;
}

export interface DownloadSetting {
    readonly verify: "strict" | "warn" | "off";
    readonly sources: readonly DownloadSource[];
}

export interface Appearance {
    readonly color: "auto" | "always" | "never";
    readonly unicode: boolean;
    readonly progress: "bar" | "plain" | "off";
}

export interface LogSetting {
    readonly enabled: boolean;
    readonly level: ConfigLogLevel;
    readonly directory?: string | null;
    readonly keep: number;
}

export interface LaunchSetting {
    readonly memory: Memory;
    readonly window: Window;
    readonly jvmArgs: readonly string[];
    readonly gameArgs: readonly string[];
    readonly waitForExit: boolean;
}

export interface ModSetting {
    readonly provider: "modrinth" | "curseforge";
    readonly installDependencies: boolean;
}

export interface CleanupSetting {
    readonly orphan: "ask" | "auto" | "never";
}

/** 按字段选择是否改用上层（文件夹 → 全局）的值 */
export interface UseGlobalSettings {
    readonly isolation?: boolean;
    readonly java?: boolean;
    readonly memory?: boolean;
    readonly window?: boolean;
    readonly jvmArgs?: boolean;
    readonly gameArgs?: boolean;
}

export interface Instance {
    /** 同时是 versions/<id>/ 的目录名 */
    readonly id: string;
    readonly name?: string;
    /** 继承的版本 json id */
    readonly target: string;
    readonly loader: Loader;
    readonly useGlobalSettings?: UseGlobalSettings;
    readonly isolation?: boolean | null;
    readonly java?: string | null;
    readonly memory?: MemoryPatch | null;
    /** 追加到全局与文件夹的之后 */
    readonly jvmArgs: readonly string[];
    readonly gameArgs: readonly string[];
    readonly window?: Window | null;
    readonly notes?: string | null;
}

export interface Folder {
    readonly id: string;
    readonly name?: string;
    readonly path: string;
    readonly isolation: boolean;
    readonly autoDiscover: boolean;
    readonly missingEntries: "keep" | "drop";
    readonly java?: string | null;
    readonly memory?: MemoryPatch | null;
    readonly instances: readonly Instance[];
}

export interface Setting {
    readonly schemaVersion: number;
    readonly language: string;
    readonly appearance: Appearance;
    readonly log: LogSetting;
    readonly network: Network;
    readonly download: DownloadSetting;
    readonly java: JavaSetting;
    readonly launch: LaunchSetting;
    readonly mod: ModSetting;
    readonly cleanup: CleanupSetting;
    readonly selectedAccount?: string | null;
    readonly selectedFolder?: string | null;
    readonly folders: readonly Folder[];
}

/* ---------- accounts ---------- */

export interface OfflineAccount {
    readonly id: string;
    readonly type: "offline";
    readonly name: string;
    /** 离线模式下由名字推导，通常留 null */
    readonly uuid?: string | null;
}

export interface MicrosoftAccount {
    readonly id: string;
    readonly type: "microsoft";
    readonly name: string;
    readonly uuid?: string | null;
    readonly xuid?: string | null;
    /** null 表示需要重新登录 */
    readonly refreshToken?: string | null;
    readonly accessToken?: string | null;
    readonly expiresAt?: string | null;
}

export type Account = OfflineAccount | MicrosoftAccount;

export interface Accounts {
    readonly schemaVersion: number;
    readonly accounts: readonly Account[];
}

/* ---------- state ---------- */

export interface InstanceStat {
    readonly lastPlayedAt?: string | null;
    readonly playTimeMinutes: number;
    readonly launchCount: number;
}

export interface JavaProbe {
    readonly major?: number | null;
    readonly arch?: JavaArch | null;
    readonly vendor?: string | null;
    readonly probedAt: string;
}

export interface State {
    readonly schemaVersion: number;
    readonly lastFolder?: string | null;
    readonly lastInstance?: string | null;
    /** 键是 <文件夹 id>/<实例 id> */
    readonly instances: Readonly<Record<string, InstanceStat>>;
    /** 键是 java 可执行文件路径 */
    readonly javaProbe: Readonly<Record<string, JavaProbe>>;
}
