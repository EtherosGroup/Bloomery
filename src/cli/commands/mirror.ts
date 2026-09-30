/**
 * mirror 命令：查看与切换下载源
 *
 * 只改 setting.json 的 download.sources，写一条启用的源
 * @author IsCibocaz
 * @since 1.6.3
 */

import { loadSetting, saveSetting } from "../../config/index.ts";
import { AppError } from "../../error/index.ts";
import { SOURCE_PRESETS, presetOf, sourceOf } from "../../infra/source.ts";
import { print, renderTable } from "../../output/index.ts";
import type { Context, MirrorCommand } from "../parse.ts";

export async function runMirror(command: MirrorCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();

    if (command.action === "list") {
        const active =
            setting.download.sources.find((item) => item.enabled)?.provider ?? "official";
        if (ctx.json) {
            print(
                JSON.stringify(
                    {
                        presets: SOURCE_PRESETS,
                        active,
                        url: setting.download.sources.find((item) => item.enabled)?.url ?? null,
                    },
                    null,
                    4,
                ),
            );
            return;
        }
        print(
            renderTable(
                SOURCE_PRESETS.map((item) => [
                    item.name,
                    item.label,
                    item.name === active ? "当前" : "",
                ]),
                { indent: "  ", header: ["名字", "说明", "状态"] },
            ).join("\n"),
        );
        return;
    }

    const preset = presetOf(command.preset ?? "");
    if (preset === undefined) {
        throw new AppError("cli", "UsageError", {
            context: {
                detail: `下载源只能是 ${SOURCE_PRESETS.map((item) => item.name).join(" / ")}：${command.preset ?? ""}`,
            },
        });
    }
    const source = sourceOf(command.preset ?? "", command.url ?? null);
    if (source === undefined) {
        throw new AppError("cli", "UsageError", {
            context: { detail: `custom 要 --url <地址>` },
        });
    }

    await saveSetting({ ...setting, download: { ...setting.download, sources: [source] } });
    if (ctx.json) {
        print(JSON.stringify({ source }, null, 4));
        return;
    }
    print(`下载源 ${preset.name}${source.url === null ? "" : `  ${source.url}`}`);
}
