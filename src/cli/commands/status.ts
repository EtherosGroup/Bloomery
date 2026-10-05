/**
 * status 命令：一次拿全外壳要的环境事实
 *
 * 只读：不写 setting.json，也不写 state.json 的探测缓存
 * Java 清单逐个真探测，跑得起来才算 usable
 * @author IsCibocaz
 * @since 1.12.0
 */

import { totalmem } from "node:os";

import { loadSetting, loadState } from "../../config/index.ts";
import type { DownloadSource, JavaSetting, Setting } from "../../config/types.ts";
import { runtimeVersion } from "../../infra/package.ts";
import { pathExists } from "../../infra/fs.ts";
import { SOURCE_PRESETS, type MirrorEntry } from "../../infra/source.ts";
import { javaPresent, probeJava, resolveJavaPick } from "../../launch/index.ts";
import { logger, print, versioned, API_VERSION } from "../../output/index.ts";
import {
    configDirectory,
    logDirectory,
    osArch,
    platform,
    settingFile,
} from "../../platform/index.ts";
import {
    pickFolder,
    readFolder,
    summarizeFolder,
    type FolderView,
    type InstanceView,
} from "../../version/index.ts";
import { launchOptionsOf } from "../../launch/index.ts";
import type { Context, StatusCommand } from "../parse.ts";
import { readMirrorFile } from "./mirror.ts";

const log = logger("status");

/** 本进程实际支持的能力，外壳据此显示入口 */
const FEATURES = ["downloadQueue", "launchRepair", "modAsync", "progressKey"] as const;

interface JavaRow {
    readonly path: string;
    readonly major: number | null;
    readonly version: string | null;
    readonly kind: string;
    readonly arch: string | null;
    readonly vendor: string | null;
    readonly source: string;
    readonly present: boolean;
    readonly usable: boolean;
}

export async function runStatus(_command: StatusCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const state = await loadState();

    const folder = pickFolder(setting.folders, setting.selectedFolder);
    const summary = folder === undefined ? null : await summarizeFolder(folder);
    const view = folder === undefined ? null : await readFolder(folder);
    const selectedInstance = selectedIn(setting, view);
    const config = folder?.instances.find((item) => item.id === selectedInstance?.id);
    const options = folder === undefined ? null : launchOptionsOf(setting, folder, config);

    const java = await javaRows(setting.java);
    const pick = await resolveJavaPick(
        setting.java,
        state.javaProbe,
        options?.javaPath ?? null,
        selectedInstance?.descriptor?.javaVersion?.majorVersion ?? undefined,
    );
    const javaDefault = pick.kind === "manual" || pick.kind === "auto" ? pick.info.path : null;
    if (javaDefault !== null && !java.some((row) => row.path === javaDefault)) {
        const info = pick.kind === "manual" || pick.kind === "auto" ? pick.info : null;
        if (info !== null) {
            java.push({
                path: info.path,
                major: info.major,
                version: info.version,
                kind: info.kind,
                arch: info.arch,
                vendor: info.vendor,
                source: info.source,
                present: true,
                usable: true,
            });
        }
    }

    const cached = await readMirrorFile();
    const active = setting.download.sources.find((item) => item.enabled) ?? null;
    // 首次运行没有 setting.json：生效值都是默认值，对外按「未设置」报
    const configured = await pathExists(settingFile());

    const result = {
        cliVersion: runtimeVersion(),
        api: API_VERSION,
        node: process.version.replace(/^v/, ""),
        home: configDirectory(),
        logs: logDirectory(),
        host: {
            platform,
            arch: osArch(),
            memoryMb: Math.round(totalmem() / 1024 / 1024),
        },
        java,
        javaDefault,
        memory: {
            minMb: setting.launch.memory.minMb,
            maxMb: setting.launch.memory.maxMb,
            globalMb: setting.launch.memory.maxMb,
            currentMb: options?.memory.maxMb ?? null,
        },
        folder:
            summary === null
                ? null
                : {
                      ...summary,
                      selected: true,
                      selectedInstance: selectedInstance?.id ?? null,
                  },
        mirror: {
            source: configured ? sourceNameOf(active, cached.entries) : null,
            presets: [
                ...SOURCE_PRESETS.map((item) => ({ id: item.name, name: item.label, url: null })),
                ...cached.entries.map((item) => ({
                    id: item.name,
                    name: item.label,
                    url: item.base,
                })),
            ],
        },
        features: [...FEATURES],
    };

    if (ctx.json) {
        print(JSON.stringify(versioned(result), null, 4));
        return;
    }
    print(text(result));
}

/* ---------- 取值 ---------- */

// 当前选中的实例；只认 setting 里选的那条，且磁盘上还在
function selectedIn(setting: Setting, view: FolderView | null): InstanceView | undefined {
    const id = setting.selectedInstance;
    if (id === null || id === undefined || view === null) {
        return undefined;
    }
    return view.instances.find((item) => item.id === id);
}

async function javaRows(java: JavaSetting): Promise<JavaRow[]> {
    return Promise.all(
        java.list.map(async (entry): Promise<JavaRow> => {
            const info = await probeJava(entry.path, entry.source);
            return {
                path: entry.path,
                major: info?.major ?? entry.major ?? null,
                version: info?.version ?? null,
                kind: info?.kind ?? entry.kind,
                arch: info?.arch ?? entry.arch ?? null,
                vendor: info?.vendor ?? entry.vendor ?? null,
                source: entry.source,
                present: await javaPresent(entry.path),
                usable: info !== null,
            };
        }),
    );
}

// provider 名与预置名一致，custom 按地址回认拉来的清单
function sourceNameOf(
    source: DownloadSource | null,
    cached: readonly MirrorEntry[],
): string | null {
    if (source === null) {
        return null;
    }
    if (source.provider === "official" || source.provider === "bmclapi") {
        return source.provider;
    }
    const hit = cached.find((item) => item.base === source.url);
    return hit?.name ?? "custom";
}

function text(result: {
    cliVersion: string;
    api: number;
    node: string;
    home: string;
    java: readonly JavaRow[];
    javaDefault: string | null;
    memory: { maxMb: number };
    folder: { name: string; path: string; instanceCount: number } | null;
    mirror: { source: string | null };
}): string {
    const lines = [
        `CLI      ${result.cliVersion}（api ${result.api}）`,
        `Node     ${result.node}`,
        `数据目录 ${result.home}`,
        `Java     ${result.java.length} 个${
            result.javaDefault === null ? "，未指定默认" : `，默认 ${result.javaDefault}`
        }`,
        `内存     上限 ${result.memory.maxMb}MB`,
        `下载源   ${result.mirror.source ?? "未设置"}`,
    ];
    if (result.folder !== null) {
        lines.push(
            `文件夹   ${result.folder.name}  ${result.folder.path}（${result.folder.instanceCount} 个实例）`,
        );
    } else {
        lines.push("文件夹   未设置");
    }
    log.debug("环境快照 %d 个 Java", result.java.length);
    return lines.join("\n");
}
