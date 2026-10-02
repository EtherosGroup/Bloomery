/**
 * Java 运行时：定位、探测、选择
 *
 * 探测跑 java -XshowSettings:properties -version，属性行比 -version 首行可靠
 * 同一份 JVM 常有多个入口路径，按 realpath 去重
 * 清单是缓存：扫描结果合并回 setting.json，探测结论写进 state.json 的 javaProbe
 * manual 项跑不起来也留在清单里，detected 与 downloaded 项文件没了就丢
 * @author IsCibocaz
 * @since 1.0.0
 */

import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import type {
    JavaArch,
    JavaEntry,
    JavaKind,
    JavaProbe,
    JavaSetting,
    JavaSource,
} from "../config/types.ts";
import { logger } from "../output/index.ts";
import {
    JAVA_EXECUTABLE,
    JAVAC_EXECUTABLE,
    configDirectory,
    expandHome,
    javaLayout,
    requiresShell,
} from "../platform/index.ts";

const log = logger("java");

const PROBE_TIMEOUT_MS = 20_000;
const PROBE_MAX_BYTES = 1024 * 1024;
// 探测缓存的新鲜度，超过就重探
const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// JAVA_HOME 或安装目录下的候选位置
const JAVA_HOME_LAYOUT = [
    join("bin", JAVA_EXECUTABLE),
    JAVA_EXECUTABLE,
    join("Contents", "Home", "bin", "java"),
] as const;

// 来源优先级，数字小的先用
const SOURCE_RANK: Record<JavaSource, number> = { manual: 0, downloaded: 1, detected: 2 };

export interface JavaInfo {
    readonly path: string;
    readonly major: number | null;
    readonly arch: JavaArch | null;
    readonly vendor: string | null;
    readonly kind: JavaKind;
    readonly home: string | null;
    readonly source: JavaSource;
    /** 这份结论产生的时刻，来自缓存时保留原值 */
    readonly probedAt: string;
}

export interface JavaScan {
    readonly entries: readonly JavaEntry[];
    readonly probes: Readonly<Record<string, JavaProbe>>;
}

/* ---------- 探测 ---------- */

export async function probeJava(
    path: string,
    source: JavaSource = "detected",
): Promise<JavaInfo | null> {
    const output = await run(path, ["-XshowSettings:properties", "-version"]).catch(
        (error: unknown) => {
            log.debug(
                "探测 %s 失败：%s",
                path,
                error instanceof Error ? error.message : String(error),
            );
            return undefined;
        },
    );
    if (output === undefined) {
        return null;
    }

    const properties = parseJavaProperties(output);
    const version = properties["java.version"];
    if (version === undefined) {
        log.debug("%s 的输出里没有 java.version", path);
        return null;
    }

    return {
        path,
        major: majorOfVersion(version),
        arch: javaArchOf(properties["os.arch"] ?? ""),
        vendor: properties["java.vendor"] ?? null,
        kind: (await exists(join(dirname(path), JAVAC_EXECUTABLE))) ? "jdk" : "jre",
        home: properties["java.home"] ?? null,
        source,
        probedAt: new Date().toISOString(),
    };
}

// 属性行形如 "    java.version = 21.0.12.1"
const PROPERTY = /^\s+([A-Za-z0-9_.]+)\s*=\s*(.*?)\s*$/;

export function parseJavaProperties(output: string): Record<string, string> {
    const properties: Record<string, string> = {};
    for (const line of output.split(/\r?\n/)) {
        const matched = PROPERTY.exec(line);
        const key = matched?.[1];
        const value = matched?.[2];
        if (key !== undefined && value !== undefined) {
            properties[key] = value;
        }
    }
    return properties;
}

// 1.8.0_402 → 8，21.0.12.1 → 21，25 → 25
export function majorOfVersion(version: string): number | null {
    const parts = version.split(/[._-]/);
    const first = parts[0];
    if (first === undefined || first === "") {
        return null;
    }
    if (first === "1") {
        const second = parts[1];
        const legacy = second === undefined ? Number.NaN : Number.parseInt(second, 10);
        return Number.isInteger(legacy) ? legacy : null;
    }
    const value = Number.parseInt(first, 10);
    return Number.isInteger(value) ? value : null;
}

export function javaArchOf(osArch: string): JavaArch | null {
    switch (osArch.trim().toLowerCase()) {
        case "amd64":
        case "x86_64":
        case "x64":
            return "x64";
        case "x86":
        case "i386":
        case "i486":
        case "i586":
        case "i686":
            return "x86";
        case "aarch64":
        case "arm64":
            return "arm64";
        case "arm":
        case "armv6l":
        case "armv7l":
            return "arm";
        default:
            return null;
    }
}

// 收 stdout 与 stderr，超时或输出过大就杀掉
function run(executable: string, args: readonly string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...args], {
            shell: requiresShell(executable),
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        let size = 0;
        let done = false;
        let timer: NodeJS.Timeout | undefined;

        const finish = (action: () => void): void => {
            if (done) {
                return;
            }
            done = true;
            if (timer !== undefined) {
                clearTimeout(timer);
            }
            action();
        };
        const collect = (chunk: Buffer): void => {
            size += chunk.length;
            if (size > PROBE_MAX_BYTES) {
                finish(() => {
                    child.kill();
                    reject(new Error("探测输出过大"));
                });
                return;
            }
            chunks.push(chunk);
        };

        timer = setTimeout(() => {
            finish(() => {
                child.kill();
                reject(new Error("探测超时"));
            });
        }, PROBE_TIMEOUT_MS);

        child.stdout?.on("data", collect);
        child.stderr?.on("data", collect);
        child.on("error", (error) => finish(() => reject(error)));
        child.on("close", () => finish(() => resolve(Buffer.concat(chunks).toString("utf8"))));
    });
}

/* ---------- 定位 ---------- */

// 入参可以是可执行文件、JAVA_HOME 或安装目录
export async function resolveJavaExecutable(input: string): Promise<string | undefined> {
    const absolute = resolve(expandHome(input));
    const info = await stat(absolute).catch(() => undefined);
    if (info === undefined) {
        return undefined;
    }
    if (info.isFile()) {
        return absolute;
    }
    if (!info.isDirectory()) {
        return undefined;
    }
    for (const relative of JAVA_HOME_LAYOUT) {
        const candidate = join(absolute, relative);
        if (await exists(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

// 候选来源：JAVA_HOME、PATH、各平台安装根、下载的运行时目录
export async function findJava(setting: JavaSetting): Promise<string[]> {
    const found: string[] = [];
    const seen = new Set<string>();
    const add = async (candidate: string): Promise<void> => {
        const info = await stat(candidate).catch(() => undefined);
        if (info?.isFile() !== true) {
            return;
        }
        const key = await realpath(candidate).catch(() => candidate);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        found.push(candidate);
    };

    const home = process.env["JAVA_HOME"];
    if (home !== undefined && home !== "") {
        for (const relative of JAVA_HOME_LAYOUT) {
            await add(join(home, relative));
        }
    }

    for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
        if (directory !== "") {
            await add(join(directory, JAVA_EXECUTABLE));
        }
    }

    const layout = javaLayout();
    for (const root of [...layout.roots, runtimeDirectory(setting)]) {
        for (const relative of layout.relative) {
            await add(join(root, relative));
        }
        for (const directory of await subdirectories(root)) {
            for (const relative of layout.relative) {
                await add(join(directory, relative));
            }
        }
    }

    return found;
}

// 下载的运行时存放目录
export function runtimeDirectory(setting: JavaSetting): string {
    const configured = setting.runtimeDirectory;
    return configured === null || configured === undefined || configured === ""
        ? join(configDirectory(), "java")
        : resolve(expandHome(configured));
}

// 可执行文件是否还在
export function javaPresent(path: string): Promise<boolean> {
    return exists(path);
}

export function javaEntryOf(info: JavaInfo): JavaEntry {
    return {
        path: info.path,
        major: info.major,
        kind: info.kind,
        arch: info.arch,
        vendor: info.vendor,
        source: info.source,
    };
}

export function javaProbeOf(info: JavaInfo): JavaProbe {
    return {
        major: info.major,
        arch: info.arch,
        vendor: info.vendor,
        probedAt: info.probedAt,
    };
}

/* ---------- 扫描与选择 ---------- */

// 扫描本机并合并进清单，每次都是真探测
export async function scanJava(setting: JavaSetting): Promise<JavaScan> {
    const entries: JavaEntry[] = [];
    const probes: Record<string, JavaProbe> = {};
    const seen = new Set<string>();
    const runtime = runtimeDirectory(setting);

    const take = async (path: string, source: JavaSource, keepBroken: boolean): Promise<void> => {
        const key = await realpath(path).catch(() => path);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);

        const info = await probeJava(path, source);
        if (info === null) {
            if (keepBroken) {
                log.warn("手动指定的 Java %s 跑不起来，仍留在清单里", path);
                entries.push({
                    path,
                    major: null,
                    kind: "jdk",
                    arch: null,
                    vendor: null,
                    source,
                });
            }
            return;
        }
        entries.push(javaEntryOf(info));
        probes[path] = javaProbeOf(info);
    };

    const known = new Map<string, JavaEntry>();
    for (const entry of setting.list) {
        known.set(await realpath(entry.path).catch(() => entry.path), entry);
    }

    for (const entry of setting.list) {
        if (entry.source === "manual") {
            await take(entry.path, "manual", true);
        }
    }

    for (const path of await findJava(setting)) {
        const key = await realpath(path).catch(() => path);
        if (seen.has(key)) {
            continue;
        }
        const previous = known.get(key);
        const source = previous?.source ?? (path.startsWith(runtime) ? "downloaded" : "detected");
        await take(path, source, false);
    }

    return { entries, probes };
}

// 从清单里挑一个：给了主版本就要相等的，同分时来源优先、版本高的优先
export async function resolveJava(
    setting: JavaSetting,
    cached: Readonly<Record<string, JavaProbe>>,
    major?: number,
): Promise<JavaInfo | undefined> {
    const candidates = await candidatesOf(setting, cached);
    const matching =
        major === undefined ? candidates : candidates.filter((info) => info.major === major);
    if (matching.length === 0) {
        return undefined;
    }
    matching.sort(byPreference);
    return matching[0];
}

export interface JavaChoice {
    readonly info: JavaInfo;
    /** true 表示没有主版本相等的，退到了更新的版本 */
    readonly fallback: boolean;
}

// 首选主版本相等；没有再退到不小于要求的最低版本，越接近要求越稳；只有更旧的不给
export function chooseJava(
    candidates: readonly JavaInfo[],
    major: number | undefined,
): JavaChoice | undefined {
    if (candidates.length === 0) {
        return undefined;
    }

    if (major === undefined) {
        const info = [...candidates].sort(byPreference)[0];
        return info === undefined ? undefined : { info, fallback: false };
    }

    const exact = candidates.filter((info) => info.major === major);
    if (exact.length > 0) {
        exact.sort(byPreference);
        const info = exact[0];
        return info === undefined ? undefined : { info, fallback: false };
    }

    const newer = candidates.filter((info) => (info.major ?? 0) > major);
    if (newer.length === 0) {
        return undefined;
    }
    newer.sort(
        (a, b) => (a.major ?? 0) - (b.major ?? 0) || SOURCE_RANK[a.source] - SOURCE_RANK[b.source],
    );
    const info = newer[0];
    return info === undefined ? undefined : { info, fallback: true };
}

// 启动与详情共用：先探清单里能跑起来的那些，再按主版本挑
export async function resolveJavaFor(
    setting: JavaSetting,
    cached: Readonly<Record<string, JavaProbe>>,
    major: number | undefined,
): Promise<JavaChoice | undefined> {
    return chooseJava(await candidatesOf(setting, cached), major);
}

/**
 * 详情与启动共用：实例或文件夹指定的路径优先，否则按主版本从清单里挑
 *
 * detail 是指定路径用不了时的详情：manualMissing 给原始输入，manualBroken 给落到的那条
 */
export type JavaPick =
    | { readonly kind: "manual"; readonly info: JavaInfo }
    | { readonly kind: "manualMissing"; readonly detail: string }
    | { readonly kind: "manualBroken"; readonly detail: string }
    | { readonly kind: "auto"; readonly info: JavaInfo; readonly fallback: boolean }
    | { readonly kind: "autoMissing" };

// javaPath 来自 launchOptionsOf，实例与文件夹的覆盖都在那里收口
export async function resolveJavaPick(
    setting: JavaSetting,
    cached: Readonly<Record<string, JavaProbe>>,
    javaPath: string | null,
    major: number | undefined,
): Promise<JavaPick> {
    // 实例或文件夹指定了路径就以它为准
    if (javaPath !== null) {
        const path = await resolveJavaExecutable(javaPath);
        if (path === undefined) {
            return { kind: "manualMissing", detail: javaPath };
        }
        const info = await probeJava(path, "manual");
        if (info === null) {
            return { kind: "manualBroken", detail: path };
        }
        return { kind: "manual", info };
    }

    const choice = await resolveJavaFor(setting, cached, major);
    if (choice === undefined) {
        return { kind: "autoMissing" };
    }
    return { kind: "auto", info: choice.info, fallback: choice.fallback };
}

// 清单里能跑起来的那些，缺信息的按缓存或重探
async function candidatesOf(
    setting: JavaSetting,
    cached: Readonly<Record<string, JavaProbe>>,
): Promise<JavaInfo[]> {
    const candidates: JavaInfo[] = [];
    for (const entry of setting.list) {
        const info = await probeCached(entry.path, entry.source, cached[entry.path]);
        if (info !== null) {
            candidates.push(info);
        }
    }
    return candidates;
}

function byPreference(a: JavaInfo, b: JavaInfo): number {
    return SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || (b.major ?? 0) - (a.major ?? 0);
}

// 缓存新鲜且文件还在就不重探
async function probeCached(
    path: string,
    source: JavaSource,
    cached: JavaProbe | undefined,
): Promise<JavaInfo | null> {
    if (!(await exists(path))) {
        return null;
    }
    if (cached === undefined || !fresh(cached)) {
        return probeJava(path, source);
    }
    return {
        path,
        major: cached.major ?? null,
        arch: cached.arch ?? null,
        vendor: cached.vendor ?? null,
        kind: (await exists(join(dirname(path), JAVAC_EXECUTABLE))) ? "jdk" : "jre",
        home: null,
        source,
        probedAt: cached.probedAt,
    };
}

function fresh(probe: JavaProbe): boolean {
    const at = Date.parse(probe.probedAt);
    return Number.isFinite(at) && Date.now() - at < PROBE_TTL_MS;
}

// 只收目录，符号链接要看 stat，JVM 目录常常是软链
async function subdirectories(root: string): Promise<string[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const directories: string[] = [];
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isDirectory()) {
            directories.push(path);
            continue;
        }
        if (entry.isSymbolicLink()) {
            const info = await stat(path).catch(() => undefined);
            if (info?.isDirectory() === true) {
                directories.push(path);
            }
        }
    }
    return directories;
}

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}
