/**
 * view 命令：加载器与游戏版本的互相查询
 *
 * view loader [名字]        四种加载器概览，或某个加载器的全部版本
 * view loader <名字> --game <版本>   这个游戏版本上可用的加载器版本
 * view loader <名字> --games         这个加载器支持的游戏版本
 * view game <版本>          这个游戏版本上四种加载器各有哪些版本
 * 通道由版本号判断，--type 只看某一个；每页 20 条
 * @author IsCibocaz
 * @since 1.1.6
 */

import { loadSetting } from "../../config/index.ts";
import type { DownloadSetting, Network } from "../../config/types.ts";
import { AppError } from "../../error/index.ts";
import type { TransferOptions } from "../../infra/download.ts";
import { sourcesOf } from "../../infra/source.ts";
import { logger, paginate, print, renderTable, type Page } from "../../output/index.ts";
import {
    filterChannel,
    listLoaderGames,
    listLoaderVersions,
    listLoaderVersionsFor,
    type LoaderChannel,
    type LoaderName,
    type LoaderVersion,
} from "../../version/index.ts";
import type { Context, ViewCommand } from "../parse.ts";

const log = logger("view");

const PER_PAGE = 20;
const NAMES: readonly LoaderName[] = ["fabric", "forge", "neoforge", "quilt"];
const INSTALLABLE: readonly LoaderName[] = ["fabric", "forge", "neoforge", "quilt"];
const CHANNELS: readonly LoaderChannel[] = ["release", "beta", "alpha"];
const LABEL: Record<LoaderChannel, string> = { release: "正式", beta: "测试", alpha: "预览" };

export async function runView(command: ViewCommand, ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const network = transferOf(setting.network, setting.download);
    const channel = asChannel(command.type);

    if (command.action === "game") {
        return gameView(requiredVersion(command.game), network, channel, command, ctx);
    }
    if (command.games === true) {
        return gameList(asLoader(requiredName(command.loader)), network, command, ctx);
    }
    if (command.game !== undefined) {
        return forGame(
            asLoader(requiredName(command.loader)),
            command.game,
            network,
            channel,
            command,
            ctx,
        );
    }
    if (command.loader === undefined) {
        return overview(network, channel, ctx);
    }
    return versions(asLoader(command.loader), network, channel, command, ctx);
}

// 不带名字：四种加载器各自的最新版与规模
async function overview(
    network: TransferOptions,
    channel: LoaderChannel | undefined,
    ctx: Context,
): Promise<void> {
    const rows: Array<{ name: LoaderName; latest: string | null; total: number }> = [];

    for (const name of NAMES) {
        const list = filterChannel(await listLoaderVersions(name, network), channel);
        rows.push({ name, latest: list[0]?.version ?? null, total: list.length });
        log.debug("%s 命中 %d 版", name, list.length);
    }

    if (ctx.json) {
        print(JSON.stringify({ type: channel ?? null, loaders: rows }, null, 4));
        return;
    }

    print(`${channel === undefined ? "全部通道" : `只看 ${channel}`}：`);
    print(
        renderTable(
            rows.map((row) => [
                row.name,
                row.latest ?? "没有",
                String(row.total),
                INSTALLABLE.includes(row.name) ? "已支持" : "未实现",
            ]),
            { indent: "  ", header: ["加载器", "最新版", "版本数", "安装"] },
        ).join("\n"),
    );
    print("");
    print("用法：bloomery view loader <加载器> [--game <版本>] [--games] [--page <n>]");
    print("      bloomery view game <版本>");
}

// 某个加载器的全部版本
async function versions(
    name: LoaderName,
    network: TransferOptions,
    channel: LoaderChannel | undefined,
    command: ViewCommand,
    ctx: Context,
): Promise<void> {
    const list = filterChannel(await listLoaderVersions(name, network), channel);
    const page = paginate(list, command.page ?? 1, PER_PAGE);
    const scope = channel === undefined ? "" : `（只看 ${channel}）`;

    if (ctx.json) {
        print(JSON.stringify(pageJson({ loader: name, type: channel ?? null }, page), null, 4));
        return;
    }
    if (page.total === 0) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: `${name} 没有匹配的版本` },
        });
    }

    print(`${name} 可用版本${scope}：第 ${page.page}/${page.pages} 页，共 ${page.total} 条`);
    print(
        renderTable(
            page.items.map((item) => [item.version, LABEL[item.channel], item.gameVersion ?? ""]),
            { indent: "  ", header: ["版本", "通道", "游戏版本"] },
        ).join("\n"),
    );
    nextPage(`bloomery view loader ${name}`, command, page, ctx);
    if (!INSTALLABLE.includes(name)) {
        print("");
        print(`注意：安装目前只支持 ${INSTALLABLE.join(" / ")}，${name} 只列版本`);
    }
}

// 某个游戏版本上可用的加载器版本
async function forGame(
    name: LoaderName,
    game: string,
    network: TransferOptions,
    channel: LoaderChannel | undefined,
    command: ViewCommand,
    ctx: Context,
): Promise<void> {
    const list = filterChannel(await listLoaderVersionsFor(name, game, network), channel);
    const page = paginate(list, command.page ?? 1, PER_PAGE);

    if (ctx.json) {
        print(
            JSON.stringify(pageJson({ loader: name, game, type: channel ?? null }, page), null, 4),
        );
        return;
    }
    if (page.total === 0) {
        throw new AppError("cli", "VersionNotFound", {
            context: {
                detail: `${name} 在 ${game} 上没有版本${channel === undefined ? "" : `（${channel} 通道）`}`,
            },
        });
    }

    print(`${name} 在 ${game} 上可用：第 ${page.page}/${page.pages} 页，共 ${page.total} 条`);
    print(
        renderTable(
            page.items.map((item) => [item.version, LABEL[item.channel]]),
            { indent: "  ", header: ["版本", "通道"] },
        ).join("\n"),
    );
    nextPage(`bloomery view loader ${name} --game ${game}`, command, page, ctx);
}

// 某个游戏版本：四种加载器各有哪些版本
async function gameView(
    game: string,
    network: TransferOptions,
    channel: LoaderChannel | undefined,
    command: ViewCommand,
    ctx: Context,
): Promise<void> {
    const rows: Array<{ loader: LoaderName; version: string; channel: LoaderChannel }> = [];
    const counts: Array<{ loader: LoaderName; total: number; latest: string | null }> = [];

    const warnings: string[] = [];
    for (const name of NAMES) {
        let list: readonly LoaderVersion[];
        try {
            list = filterChannel(await listLoaderVersionsFor(name, game, network), channel);
        } catch (error) {
            // 一家取不到不影响其余三家，记一条警告
            warnings.push(
                `${name} 取不到：${error instanceof Error ? error.message : String(error)}`,
            );
            counts.push({ loader: name, total: 0, latest: null });
            continue;
        }
        counts.push({ loader: name, total: list.length, latest: list[0]?.version ?? null });
        for (const item of list) {
            rows.push({ loader: name, version: item.version, channel: item.channel });
        }
    }

    const page = paginate(rows, command.page ?? 1, PER_PAGE);
    if (ctx.json) {
        print(
            JSON.stringify(
                {
                    ...pageJson({ game, type: channel ?? null }, page),
                    loaders: counts,
                    warnings,
                    versions: page.items,
                },
                null,
                4,
            ),
        );
        return;
    }

    print(`游戏版本 ${game}：`);
    print(
        renderTable(
            counts.map((row) => [
                row.loader,
                row.latest ?? "没有",
                String(row.total),
                INSTALLABLE.includes(row.loader) ? "可装" : "未实现",
            ]),
            { indent: "  ", header: ["加载器", "最新版", "版本数", "安装"] },
        ).join("\n"),
    );
    if (page.total === 0) {
        print("");
        print("四种加载器都没有这个游戏版本的记录");
        return;
    }

    print("");
    print(`全部版本：第 ${page.page}/${page.pages} 页，共 ${page.total} 条`);
    print(
        renderTable(
            page.items.map((item) => [item.loader, item.version, LABEL[item.channel]]),
            { indent: "  ", header: ["加载器", "版本", "通道"] },
        ).join("\n"),
    );
    nextPage(`bloomery view game ${game}`, command, page, ctx);
    for (const warning of warnings) {
        print(`  警告      ${warning}`);
    }
}

// 某个加载器支持的游戏版本
async function gameList(
    name: LoaderName,
    network: TransferOptions,
    command: ViewCommand,
    ctx: Context,
): Promise<void> {
    const games = await listLoaderGames(name, network);
    const page = paginate(games, command.page ?? 1, PER_PAGE);
    if (ctx.json) {
        print(JSON.stringify({ ...pageJson({ loader: name }, page), games: page.items }, null, 4));
        return;
    }
    if (page.total === 0) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: `${name} 的游戏版本清单是空的` },
        });
    }

    print(`${name} 支持的游戏版本：第 ${page.page}/${page.pages} 页，共 ${page.total} 条`);
    print(
        renderTable(
            page.items.map((game) => [game]),
            { indent: "  ", header: ["游戏版本"] },
        ).join("\n"),
    );
    nextPage(`bloomery view loader ${name} --games`, command, page, ctx);
}

/* ---------- 小工具 ---------- */

function pageJson(head: Record<string, unknown>, page: Page<unknown>): Record<string, unknown> {
    return {
        ...head,
        page: page.page,
        pages: page.pages,
        perPage: page.perPage,
        total: page.total,
        versions: page.items,
    };
}

function nextPage(base: string, command: ViewCommand, page: Page<unknown>, ctx: Context): void {
    if (page.page >= page.pages) {
        return;
    }
    const type = command.type === undefined ? "" : ` --type ${command.type}`;
    print("");
    print(`下一页：${base} --page ${page.page + 1}${type}`);
}

function requiredVersion(value: string | undefined): string {
    if (value === undefined || value === "") {
        throw new AppError("cli", "UsageError", {
            context: { detail: "view game 要给游戏版本，例如 bloomery view game 1.20.6" },
        });
    }
    return value;
}

function requiredName(value: string | undefined): string {
    if (value === undefined || value === "") {
        throw new AppError("cli", "UsageError", {
            context: { detail: "view loader 要给加载器名字，或省略看概览" },
        });
    }
    return value;
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

// 省略为全部；写错就报用法错误，不猜
function asChannel(text: string | undefined): LoaderChannel | undefined {
    if (text === undefined) {
        return undefined;
    }
    const name = text.trim().toLowerCase();
    if (name === "all" || name === "") {
        return undefined;
    }
    if (!(CHANNELS as readonly string[]).includes(name)) {
        throw new AppError("cli", "UsageError", {
            context: { detail: `通道只能是 ${CHANNELS.join(" / ")} 或 all：${text}` },
        });
    }
    return name as LoaderChannel;
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
