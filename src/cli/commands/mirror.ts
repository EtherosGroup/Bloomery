/**
 * mirror 命令：查看、切换下载源，或从镜像站拉取清单
 *
 * 拉来的清单缓存在 <配置目录>/mirrors.json，use 时按 custom 写入 setting.json
 * @author IsCibocaz
 * @since 1.6.3
 */

import { loadSetting, saveSetting } from "../../config/index.ts";
import { object, parseJson } from "../../config/read.ts";
import { AppError } from "../../error/index.ts";
import { fetchBuffer, type FetchOptions } from "../../infra/download.ts";
import { readText, writeAtomic } from "../../infra/fs.ts";
import {
    SOURCE_PRESETS,
    parseMirrorList,
    presetOf,
    sourceFor,
    sourcesOf,
    type MirrorEntry,
} from "../../infra/source.ts";
import { print, renderTable, versioned } from "../../output/index.ts";
import { mirrorListFile } from "../../platform/index.ts";
import type { Context, MirrorCommand } from "../parse.ts";

interface MirrorFile {
    readonly from: string | null;
    readonly fetchedAt: string | null;
    readonly entries: readonly MirrorEntry[];
}

export async function runMirror(command: MirrorCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const cached = await readMirrorFile();

    if (command.action === "update") {
        return update(command, setting, cached, ctx);
    }

    const active = setting.download.sources.find((item) => item.enabled) ?? null;

    if (command.action === "list") {
        if (ctx.json) {
            print(
                JSON.stringify(
                    { presets: SOURCE_PRESETS, mirrors: cached.entries, source: active },
                    null,
                    4,
                ),
            );
            return;
        }
        const rows = [
            ...SOURCE_PRESETS.map((item) => [item.name, item.label, "预置", ""]),
            ...cached.entries.map((item) => [item.name, item.label, "拉取", item.base]),
        ];
        print(
            renderTable(rows, {
                indent: "  ",
                header: ["名字", "说明", "来源", "地址"],
            }).join("\n"),
        );
        if (active !== null) {
            print(`当前 ${active.provider}${active.url === null ? "" : `  ${active.url}`}`);
        }
        if (cached.from !== null) {
            print(`清单 ${cached.from}`);
        }
        return;
    }

    // use
    const wanted = command.preset ?? "";
    const source = sourceFor(wanted, command.url ?? null, cached.entries);
    if (source === undefined) {
        const names = [
            ...SOURCE_PRESETS.map((item) => item.name),
            ...cached.entries.map((item) => item.name),
        ];
        throw new AppError("cli", "UsageError", {
            context: { detail: `下载源只能是 ${names.join(" / ")}：${wanted}` },
        });
    }
    if (presetOf(wanted)?.provider === "custom" && source.url === null) {
        throw new AppError("cli", "UsageError", {
            context: { detail: "custom 要 --url <地址>" },
        });
    }

    await saveSetting({ ...setting, download: { ...setting.download, sources: [source] } });
    if (ctx.json) {
        print(JSON.stringify(versioned({ source }), null, 4));
        return;
    }
    print(`下载源 ${wanted}${source.url === null ? "" : `  ${source.url}`}`);
}

async function update(
    command: MirrorCommand,
    setting: Awaited<ReturnType<typeof loadSetting>>,
    cached: MirrorFile,
    ctx: Context,
): Promise<void> {
    const url = (command.from ?? cached.from ?? "").trim();
    if (url === "") {
        throw new AppError("cli", "UsageError", {
            context: { detail: "update 要 --from <地址>" },
        });
    }

    const options: FetchOptions = {
        timeoutMs: setting.network.timeoutMs,
        retries: setting.network.retries,
        proxy: setting.network.proxy ?? null,
        noProxy: setting.network.noProxy,
        sources: sourcesOf(setting.download),
    };
    const buffer = await fetchBuffer(url, options);
    const entries = parseMirrorList(parseJson(buffer.toString("utf8"), url), url);
    if (entries.length === 0) {
        throw new AppError("cli", "UsageError", {
            context: { detail: `镜像清单没有可用条目：${url}` },
        });
    }

    const file: MirrorFile = { from: url, fetchedAt: new Date().toISOString(), entries };
    await writeAtomic(mirrorListFile(), `${JSON.stringify(file, null, 4)}\n`);

    if (ctx.json) {
        print(JSON.stringify(file, null, 4));
        return;
    }
    print(`镜像清单 ${entries.length} 条  ${url}`);
}

async function readMirrorFile(): Promise<MirrorFile> {
    const path = mirrorListFile();
    const text = await readText(path);
    if (text === undefined) {
        return { from: null, fetchedAt: null, entries: [] };
    }
    const raw = object(parseJson(text, path), path) ?? {};
    const from = raw["from"];
    const fetchedAt = raw["fetchedAt"];
    return {
        from: typeof from === "string" ? from : null,
        fetchedAt: typeof fetchedAt === "string" ? fetchedAt : null,
        entries: parseMirrorList(raw, path),
    };
}
