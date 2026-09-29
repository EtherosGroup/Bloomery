/**
 * 游戏文件夹
 *
 * 路径来自 setting.json 的 folders[].path，可写 ~，解析后统一成绝对路径
 * 配置里的 instances 只是缓存提示，磁盘才是准；读的时候两边核对
 * 只支持隔离：实例的游戏目录就是 versions/<id>，mods/saves/config 都在里面
 * @author IsCibocaz
 * @since 1.0.0
 */

import { access, constants, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { Folder, Instance, Loader } from "../config/types.ts";
import { logger } from "../output/index.ts";
import { expandHome, platform } from "../platform/index.ts";
import { loaderOf, resolveDescriptor, type Descriptor, type VersionType } from "./descriptor.ts";
import { scanVersions, type LocalVersion } from "./store.ts";

const log = logger("version");

const VANILLA: Loader = { type: "vanilla", version: null };

export type InstanceState = "ready" | "missing" | "broken" | "incomplete";

export interface InstanceView {
    readonly id: string;
    readonly name: string;
    readonly target: string;
    readonly loader: Loader;
    /** 隔离后的游戏目录 */
    readonly directory: string;
    readonly state: InstanceState;
    readonly type: VersionType | null;
    /** 合并 inheritsFrom 之后 */
    readonly descriptor: Descriptor | null;
    /** 自身到最底层的 id 顺序，读不出来时为空 */
    readonly chain: readonly string[];
    /** 配置清单里有 */
    readonly configured: boolean;
    /** 磁盘上有、清单里没写 */
    readonly discovered: boolean;
    readonly problem: string | null;
}

export interface FolderView {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly exists: boolean;
    readonly writable: boolean;
    /** versions/ */
    readonly versionsDirectory: string;
    readonly instances: readonly InstanceView[];
    /** missingEntries=drop 时摘掉的 id */
    readonly dropped: readonly string[];
}

export interface FolderProbe {
    readonly path: string;
    readonly exists: boolean;
    readonly directory: boolean;
    /** versions/ 下的版本数 */
    readonly versions: number;
}

export interface FolderSummary {
    readonly id: string;
    readonly name: string;
    readonly path: string;
    readonly exists: boolean;
    readonly writable: boolean;
    /** 配置清单里的条数，磁盘上实际有多少要看 readFolder */
    readonly instances: number;
}

export async function readFolder(folder: Folder): Promise<FolderView> {
    const path = resolveFolderPath(folder);
    const info = await stat(path).catch(() => undefined);
    const writable = await canWrite(path);
    const scan = await scanVersions(path);
    log.debug("文件夹 %s 扫到 %d 个版本", path, scan.versions.length);

    const onDisk = new Map<string, LocalVersion>();
    const byId = new Map<string, Descriptor>();
    for (const version of scan.versions) {
        onDisk.set(version.id, version);
        if (version.descriptor !== null) {
            byId.set(version.id, version.descriptor);
        }
    }

    const instances: InstanceView[] = [];
    const configured = new Set<string>();
    const dropped: string[] = [];

    for (const instance of folder.instances) {
        configured.add(instance.id);
        const view = configuredView(instance, onDisk.get(instance.id), byId, scan.directory);
        if (view.state === "missing" && folder.missingEntries === "drop") {
            dropped.push(instance.id);
            continue;
        }
        instances.push(view);
    }

    if (folder.autoDiscover) {
        for (const version of scan.versions) {
            if (!configured.has(version.id)) {
                instances.push(discoveredView(version, byId));
            }
        }
    }

    return {
        id: folder.id,
        name: folder.name ?? folder.id,
        path,
        exists: info?.isDirectory() === true,
        writable,
        versionsDirectory: scan.directory,
        instances,
        dropped,
    };
}

export async function findInstance(folder: Folder, id: string): Promise<InstanceView | undefined> {
    const view = await readFolder(folder);
    return view.instances.find((instance) => instance.id === id);
}

export async function probeFolder(path: string): Promise<FolderProbe> {
    const absolute = resolveGameFolder(path);
    const info = await stat(absolute).catch(() => undefined);
    if (info?.isDirectory() !== true) {
        return { path: absolute, exists: info !== undefined, directory: false, versions: 0 };
    }
    const scan = await scanVersions(absolute);
    return { path: absolute, exists: true, directory: true, versions: scan.versions.length };
}

export function resolveFolderPath(folder: Folder): string {
    return resolveGameFolder(folder.path);
}

// 只读配置与目录状态，不扫版本：list 只要列出保存过的那几条
export async function summarizeFolder(folder: Folder): Promise<FolderSummary> {
    const path = resolveFolderPath(folder);
    const info = await stat(path).catch(() => undefined);
    return {
        id: folder.id,
        name: folder.name ?? folder.id,
        path,
        exists: info?.isDirectory() === true,
        writable: await canWrite(path),
        instances: folder.instances.length,
    };
}

// 挑文件夹：显式指定优先，其次 setting 里选的，再次第一个
export function pickFolder(
    folders: readonly Folder[],
    selected: string | null | undefined,
    wanted?: string,
): Folder | undefined {
    if (wanted !== undefined) {
        return folders.find((folder) => folder.id === wanted);
    }
    if (selected !== null && selected !== undefined) {
        const found = folders.find((folder) => folder.id === selected);
        if (found !== undefined) {
            return found;
        }
    }
    return folders[0];
}

// 展开 ~ 并定成绝对路径
export function resolveGameFolder(path: string): string {
    return resolve(expandHome(path));
}

// 同一个目录的比较：Windows 上盘符与路径大小写不敏感
export function sameFolderPath(left: string, right: string): boolean {
    const a = normalizePath(left);
    const b = normalizePath(right);
    return a === b;
}

// 路径末段转标识：去前导点与非法字符，撞名时加序号
export function folderIdOf(path: string, taken: readonly string[]): string {
    const base = basename(resolveGameFolder(path));
    const cleaned = base
        .replace(/^\.+/, "")
        .replace(/[/\\:*?"<>|]/g, "-")
        .trim();
    const root = cleaned === "" ? "minecraft" : cleaned;
    if (!taken.includes(root)) {
        return root;
    }
    for (let index = 2; index < 1000; index++) {
        const candidate = `${root}-${index}`;
        if (!taken.includes(candidate)) {
            return candidate;
        }
    }
    return root;
}

/* ---------- 内部 ---------- */

function configuredView(
    instance: Instance,
    local: LocalVersion | undefined,
    byId: ReadonlyMap<string, Descriptor>,
    versionsDirectory: string,
): InstanceView {
    const base = {
        id: instance.id,
        name: instance.name ?? instance.id,
        target: instance.target,
        loader: instance.loader,
        directory: local?.directory ?? join(versionsDirectory, instance.id),
        configured: true,
        discovered: false,
    };

    if (local === undefined) {
        return {
            ...base,
            state: "missing",
            type: null,
            descriptor: null,
            chain: [],
            problem: "磁盘上没有这个版本",
        };
    }
    if (local.descriptor === null) {
        return {
            ...base,
            state: "broken",
            type: null,
            descriptor: null,
            chain: [],
            problem: local.problem,
        };
    }

    const resolved = resolveDescriptor(byId, instance.id);
    if (resolved === undefined) {
        return {
            ...base,
            state: "broken",
            type: null,
            descriptor: null,
            chain: [],
            problem: local.problem,
        };
    }
    return {
        ...base,
        state: resolved.problem === null ? "ready" : "incomplete",
        type: resolved.descriptor.type,
        descriptor: resolved.descriptor,
        chain: resolved.chain,
        problem: resolved.problem,
    };
}

// 磁盘上的版本，target 取 inheritsFrom，没有则取自身
function discoveredView(
    version: LocalVersion,
    byId: ReadonlyMap<string, Descriptor>,
): InstanceView {
    const base = {
        id: version.id,
        name: version.id,
        directory: version.directory,
        configured: false,
        discovered: true,
    };

    const own = version.descriptor;
    if (own === null) {
        return {
            ...base,
            target: version.id,
            loader: VANILLA,
            state: "broken",
            type: null,
            descriptor: null,
            chain: [],
            problem: version.problem,
        };
    }

    const target = own.inheritsFrom ?? version.id;
    const resolved = resolveDescriptor(byId, version.id);
    if (resolved === undefined) {
        return {
            ...base,
            target,
            loader: loaderOf(own),
            state: "broken",
            type: null,
            descriptor: null,
            chain: [],
            problem: version.problem,
        };
    }
    return {
        ...base,
        target,
        loader: loaderOf(resolved.descriptor),
        state: resolved.problem === null ? "ready" : "incomplete",
        type: resolved.descriptor.type,
        descriptor: resolved.descriptor,
        chain: resolved.chain,
        problem: resolved.problem,
    };
}

function normalizePath(path: string): string {
    const absolute = resolveGameFolder(path);
    return platform === "Windows" ? absolute.toLowerCase() : absolute;
}

async function canWrite(path: string): Promise<boolean> {
    return access(path, constants.W_OK).then(
        () => true,
        () => false,
    );
}
