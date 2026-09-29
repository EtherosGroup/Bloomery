/**
 * view 命令：查看加载器可用的版本
 *
 * 不带名字就把四种加载器的现状列出来，带上名字按每页 20 条翻
 * 目前只有 fabric 能装，另外三种只列版本，装的时候会报未实现
 * @author IsCibocaz
 * @since 1.1.6
 */

import { loadSetting } from "../../config/index.ts";
import type { DownloadSetting, Network } from "../../config/types.ts";
import { AppError } from "../../error/index.ts";
import type { TransferOptions } from "../../infra/download.ts";
import { sourcesOf } from "../../infra/source.ts";
import { logger, paginate, print, renderTable } from "../../output/index.ts";
import { listLoaderVersions, type LoaderName } from "../../version/index.ts";
import type { Context, ViewCommand } from "../parse.ts";

const log = logger("view");

const PER_PAGE = 20;
const NAMES: readonly LoaderName[] = ["fabric", "forge", "neoforge", "quilt"];
const INSTALLABLE: readonly LoaderName[] = ["fabric"];

export async function runView(command: ViewCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const network = transferOf(setting.network, setting.download);

    if (command.loader === undefined) {
        return overview(network, ctx);
    }
    return versions(asLoader(command.loader), network, command, ctx);
}

// 不带名字：四种加载器各自的最新版与规模
async function overview(network: TransferOptions, ctx: Context): Promise<void> {
    const rows: Array<{ name: LoaderName; latest: string | null; total: number }> = [];

    for (const name of NAMES) {
        const list = await listLoaderVersions(name, network);
        const newest = list.find((item) => item.stable === true) ?? list[0];
        rows.push({ name, latest: newest?.version ?? null, total: list.length });
        log.debug("%s 共 %d 版", name, list.length);
    }

    if (ctx.json) {
        print(JSON.stringify(rows, null, 4));
        return;
    }

    const table = rows.map((row) => [
        row.name,
        row.latest ?? "取不到",
        String(row.total),
        INSTALLABLE.includes(row.name) ? "已支持" : "未实现",
    ]);
    print(
        renderTable(table, { indent: "  ", header: ["加载器", "最新版", "版本数", "安装"] }).join(
            "\n",
        ),
    );
    print("");
    print("看某个加载器的全部版本：bloomery view loader <加载器> [--page <n>]");
}

async function versions(
    name: LoaderName,
    network: TransferOptions,
    command: ViewCommand,
    ctx: Context,
): Promise<void> {
    const list = await listLoaderVersions(name, network);
    if (list.length === 0) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: `${name} 的版本清单是空的` },
        });
    }

    const page = paginate(list, command.page ?? 1, PER_PAGE);
    if (ctx.json) {
        print(
            JSON.stringify(
                {
                    loader: name,
                    page: page.page,
                    pages: page.pages,
                    perPage: page.perPage,
                    total: page.total,
                    versions: page.items,
                },
                null,
                4,
            ),
        );
        return;
    }

    const table = page.items.map((item) => [
        item.version,
        item.stable === null ? "未知" : item.stable ? "正式" : "测试",
        item.gameVersion ?? "",
    ]);
    print(`${name} 可用版本：第 ${page.page}/${page.pages} 页，共 ${page.total} 条`);
    print(renderTable(table, { indent: "  ", header: ["版本", "状态", "游戏版本"] }).join("\n"));
    if (page.page < page.pages) {
        print("");
        print(`下一页：bloomery view loader ${name} --page ${page.page + 1}`);
    }
    if (!INSTALLABLE.includes(name)) {
        print("");
        print(`注意：安装目前只支持 ${INSTALLABLE.join(" / ")}，${name} 只列版本`);
    }
}

function asLoader(text: string): LoaderName {
    const name = text.trim().toLowerCase();
    if (!(NAMES as readonly string[]).includes(name)) {
        throw new AppError("cli", "UsageError", {
            context: { detail: `加载器只能是 ${NAMES.join(" / ")}：${text}` },
        });
    }
    return name as LoaderName;
}

function transferOf(network: Network, download: DownloadSetting): TransferOptions {
    return {
        timeoutMs: network.timeoutMs,
        retries: network.retries,
        proxy: network.proxy ?? null,
        noProxy: network.noProxy,
        verify: download.verify,
        concurrency: network.concurrency,
        sources: sourcesOf(download),
    };
}
