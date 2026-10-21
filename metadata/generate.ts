/**
 * 生成 cn-names.tsv
 *
 * MC百科的模组列表给中文名与英文名，Modrinth 公开搜索接口给 slug、title 与下载量
 * 两边按英文名归一化后匹配；同名多义按下载量取最常见的一项，仍并列就跳过
 * 页面缓存在 working/cn-names-cache/，断点续跑；默认每月跑一次
 * 用法：node metadata/generate.ts [--pages <n>] [--modrinth-pages <n>] [--refresh]
 * @author IsCibocaz
 * @since 1.15.0
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join as joinPath } from "node:path";

const MCMOD_LIST = "https://www.mcmod.cn/modlist.html";
const MODRINTH_SEARCH = "https://api.modrinth.com/v2/search";
const USER_AGENT = "bloomery-cn-names/1.0 (+https://github.com/EtherosGroup/Bloomery)";
const PAGE_SIZE = 100;

const DEFAULT_CACHE = "working/cn-names-cache";
const DEFAULT_OUT = "metadata/cn-names.tsv";
const DEFAULT_DELAY = 1500;
const DEFAULT_API_DELAY = 300;

interface Options {
    readonly pages: number | null;
    readonly modrinthPages: number | null;
    readonly delay: number;
    readonly apiDelay: number;
    readonly refresh: boolean;
    readonly dryRun: boolean;
    readonly cache: string;
    readonly out: string;
}

interface McmodEntry {
    readonly classId: string;
    readonly title: string;
    readonly english: string;
}

interface ModrinthProject {
    readonly slug: string;
    readonly title: string;
    readonly downloads: number;
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    console.error("阶段 1/3 抓 MC百科模组列表");
    const mcmod = await crawlMcmod(options);
    console.error("阶段 2/3 抓 Modrinth 模组清单");
    const modrinth = await crawlModrinth(options);
    console.error("阶段 3/3 匹配并落表");

    const rows = join(mcmod, modrinth);
    const text = render(rows, joinStats(mcmod, modrinth, rows));
    if (options.dryRun) {
        console.error(`演练：${rows.size} 条，不写文件`);
        return;
    }
    await mkdir(dirname(options.out), { recursive: true });
    await writeFile(options.out, text);
    console.error(`写入 ${options.out}：${rows.size} 条`);
}

/* ---------- 抓取 ---------- */

async function crawlMcmod(options: Options): Promise<readonly McmodEntry[]> {
    const first = await fetchCached(
        joinPath(options.cache, "mcmod", "page-1.html"),
        `${MCMOD_LIST}?page=1`,
        options.refresh,
        options.delay,
    );
    const total = totalPages(first);
    const pages = options.pages === null ? total : Math.min(options.pages, total);
    const entries: McmodEntry[] = parseMcmodPage(first);
    if (entries.length === 0) {
        throw new Error("MC百科第 1 页解析为空");
    }
    for (let page = 2; page <= pages; page += 1) {
        const html = await fetchCached(
            joinPath(options.cache, "mcmod", `page-${page}.html`),
            `${MCMOD_LIST}?page=${page}`,
            options.refresh,
            options.delay,
        );
        const parsed = parseMcmodPage(html);
        if (parsed.length === 0) {
            throw new Error(`MC百科第 ${page} 页解析为空，疑似被限流或页面结构变化`);
        }
        entries.push(...parsed);
        if (page % 50 === 0) {
            console.error(`  MC百科 ${page}/${pages}，累计 ${entries.length} 条`);
        }
    }
    console.error(`  MC百科 ${pages}/${total} 页，${entries.length} 条`);
    return entries;
}

async function crawlModrinth(options: Options): Promise<readonly ModrinthProject[]> {
    const first = await fetchCached(
        joinPath(options.cache, "modrinth", "page-1.json"),
        searchUrl(0),
        options.refresh,
        options.apiDelay,
    );
    const total = totalHits(first);
    const all = Math.ceil(total / PAGE_SIZE);
    const pages = options.modrinthPages === null ? all : Math.min(options.modrinthPages, all);
    const projects: ModrinthProject[] = parseModrinthPage(first);
    if (projects.length === 0) {
        throw new Error("Modrinth 第 1 页解析为空");
    }
    for (let page = 2; page <= pages; page += 1) {
        const body = await fetchCached(
            joinPath(options.cache, "modrinth", `page-${page}.json`),
            searchUrl((page - 1) * PAGE_SIZE),
            options.refresh,
            options.apiDelay,
        );
        const parsed = parseModrinthPage(body);
        if (parsed.length === 0) {
            throw new Error(`Modrinth 第 ${page} 页解析为空`);
        }
        projects.push(...parsed);
        if (page % 100 === 0) {
            console.error(`  Modrinth ${page}/${pages}，累计 ${projects.length} 条`);
        }
    }
    console.error(`  Modrinth ${pages}/${all} 页，${projects.length} 条`);
    return projects;
}

function searchUrl(offset: number): string {
    const facets = encodeURIComponent(JSON.stringify([["project_type:mod"]]));
    return `${MODRINTH_SEARCH}?query=&limit=${PAGE_SIZE}&offset=${offset}&facets=${facets}`;
}

async function fetchCached(
    path: string,
    url: string,
    refresh: boolean,
    delayMs: number,
): Promise<string> {
    if (!refresh) {
        const cached = await readFile(path, "utf8").catch(() => null);
        if (cached !== null && cached.length > 0) {
            return cached;
        }
    }
    // 只对真正发出的请求限速，缓存命中不睡
    if (delayMs > 0) {
        await sleep(delayMs);
    }
    const text = await fetchText(url);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text);
    return text;
}

async function fetchText(url: string): Promise<string> {
    let last: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            const response = await fetch(url, {
                headers: { "user-agent": USER_AGENT, accept: "text/html,application/json" },
                signal: AbortSignal.timeout(20000),
            });
            if (response.status === 429 || response.status === 403) {
                const retryAfter = Number(response.headers.get("retry-after") ?? "0");
                const wait =
                    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 10000;
                console.error(
                    `  限流（${response.status}），等待 ${Math.round(wait / 1000)}s：${url}`,
                );
                await sleep(wait);
                throw new Error(`HTTP ${response.status}`);
            }
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return await response.text();
        } catch (error) {
            last = error;
            console.error(`  请求失败（${attempt}/3）：${url}：${messageOf(error)}`);
            await sleep(2000 * attempt);
        }
    }
    throw last instanceof Error ? last : new Error(String(last));
}

/* ---------- 解析 ---------- */

const MCMOD_ITEM =
    /<p class="name"><a href="\/class\/(\d+)\.html"[^>]*>([^<]+)<\/a><\/p><p class="ename"><a[^>]*>([^<]*)<\/a>/g;

function parseMcmodPage(html: string): McmodEntry[] {
    const entries: McmodEntry[] = [];
    for (const match of html.matchAll(MCMOD_ITEM)) {
        const classId = match[1] ?? "";
        const title = decodeEntities(match[2] ?? "").trim();
        const english = decodeEntities(match[3] ?? "").trim();
        if (classId === "" || title === "" || english === "") {
            continue;
        }
        entries.push({ classId, title, english });
    }
    return entries;
}

function totalPages(html: string): number {
    const found = /当前 1 \/ (\d+) 页，共计 (\d+) 条/.exec(html);
    const pages = Number(found?.[1] ?? "0");
    if (!Number.isFinite(pages) || pages <= 0) {
        throw new Error("MC百科列表页解析不出页数");
    }
    return pages;
}

function parseModrinthPage(text: string): ModrinthProject[] {
    const body = JSON.parse(text) as { hits?: unknown };
    if (!Array.isArray(body.hits)) {
        throw new Error("Modrinth 搜索响应没有 hits");
    }
    const projects: ModrinthProject[] = [];
    for (const raw of body.hits) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }
        const hit = raw as Record<string, unknown>;
        const slug = hit["slug"];
        const title = hit["title"];
        if (typeof slug === "string" && typeof title === "string" && slug !== "" && title !== "") {
            const downloads = hit["downloads"];
            projects.push({
                slug,
                title,
                downloads:
                    typeof downloads === "number" && Number.isFinite(downloads) ? downloads : 0,
            });
        }
    }
    return projects;
}

function totalHits(text: string): number {
    const body = JSON.parse(text) as { total_hits?: unknown };
    const total = body.total_hits;
    if (typeof total !== "number" || !Number.isFinite(total) || total <= 0) {
        throw new Error("Modrinth 搜索响应没有 total_hits");
    }
    return total;
}

/* ---------- 匹配 ---------- */

interface Candidate {
    readonly project: ModrinthProject;
    readonly score: number;
}

function join(
    mcmod: readonly McmodEntry[],
    modrinth: readonly ModrinthProject[],
): ReadonlyMap<string, string> {
    const bySlug = new Map<string, ModrinthProject[]>();
    const byTitle = new Map<string, ModrinthProject[]>();
    for (const project of modrinth) {
        for (const key of keysOf(project.slug)) {
            push(bySlug, key, project);
        }
        for (const key of keysOf(project.title)) {
            push(byTitle, key, project);
        }
    }

    // 同一个 slug 可能对上多条 MC百科记录，取匹配分更高、中文名更干净的那条
    const best = new Map<
        string,
        { readonly score: number; readonly name: string; readonly clean: number }
    >();
    for (const entry of mcmod) {
        const keys = keysOf(entry.english);
        if (keys.size === 0) {
            continue;
        }
        const name = chineseName(entry.title);
        if (name === null) {
            continue;
        }

        const candidates = new Map<string, ModrinthProject>();
        for (const key of keys) {
            for (const project of bySlug.get(key) ?? []) {
                candidates.set(project.slug, project);
            }
            for (const project of byTitle.get(key) ?? []) {
                candidates.set(project.slug, project);
            }
        }
        if (candidates.size === 0) {
            continue;
        }

        const scored: Candidate[] = [...candidates.values()].map((project) => ({
            project,
            score: scoreOf(entry.english, project),
        }));
        const top = Math.max(...scored.map((one) => one.score));
        const winners = scored
            .filter((one) => one.score === top)
            .sort((left, right) => right.project.downloads - left.project.downloads);
        const winner = winners[0];
        // 同名多义按下载量取最大；仍然并列就跳过
        if (winner === undefined) {
            continue;
        }
        const second = winners[1];
        if (second !== undefined && second.project.downloads === winner.project.downloads) {
            continue;
        }

        const clean = decorationsOf(entry.title);
        const kept = best.get(winner.project.slug);
        if (kept === undefined || top > kept.score || (top === kept.score && clean < kept.clean)) {
            best.set(winner.project.slug, { score: top, name, clean });
        }
    }

    const rows = new Map<string, string>();
    for (const slug of [...best.keys()].sort()) {
        const value = best.get(slug);
        if (value !== undefined) {
            rows.set(slug, value.name);
        }
    }
    return rows;
}

function push(map: Map<string, ModrinthProject[]>, key: string, project: ModrinthProject): void {
    const list = map.get(key) ?? [];
    list.push(project);
    map.set(key, list);
}

function keysOf(text: string): ReadonlySet<string> {
    const keys = new Set<string>();
    for (const value of [text, stripDecor(text)]) {
        const key = normalize(value);
        if (key !== "") {
            keys.add(key);
        }
    }
    return keys;
}

// 100 slug 精确，95 slug 去掉装饰，90 标题精确，80 标题去掉装饰
function scoreOf(english: string, project: ModrinthProject): number {
    const keys = keysOf(english);
    let score = 0;
    if (keys.has(normalize(project.slug))) {
        score = 100;
    }
    if (keys.has(normalize(project.title))) {
        score = Math.max(score, 90);
    }
    for (const key of keysOf(project.slug)) {
        if (keys.has(key)) {
            score = Math.max(score, 95);
        }
    }
    for (const key of keysOf(project.title)) {
        if (keys.has(key)) {
            score = Math.max(score, 80);
        }
    }
    return score;
}

// 去掉括号段：[ETF] 实体纹理特性 → 实体纹理特性
function stripDecor(text: string): string {
    return text.replace(/\s*[([（【][^)\]）】]*[)\]）】]/g, " ").trim();
}

function decorationsOf(title: string): number {
    return (title.match(/[([（【]/g) ?? []).length;
}

function chineseName(title: string): string | null {
    // 去掉开头的缩写标记：[JEI] 物品管理器 → 物品管理器
    const name = title
        .replace(/^\[[^\]]*\]\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
    if (name === "" || name.length > 60) {
        return null;
    }
    // 没有汉字说明没翻译，GUI 直接用英文名即可
    if (!/[\u4e00-\u9fff]/.test(name)) {
        return null;
    }
    return name;
}

function normalize(text: string): string {
    return text
        .toLowerCase()
        .normalize("NFKC")
        .replace(/[^a-z0-9]+/g, "");
}

/* ---------- 输出 ---------- */

function render(rows: ReadonlyMap<string, string>, stats: string): string {
    const lines = [
        "# 来源：MC百科（https://www.mcmod.cn/）模组列表的中文名与英文名",
        "# 与 Modrinth 公开 API（https://api.modrinth.com/）按英文名归一化后精确匹配生成",
        `# 更新：${new Date().toISOString().slice(0, 10)}`,
        "# 格式：slug<TAB>中文名",
        stats,
    ];
    for (const slug of [...rows.keys()].sort()) {
        const name = rows.get(slug);
        if (name !== undefined) {
            lines.push(`${slug}\t${name}`);
        }
    }
    return `${lines.join("\n")}\n`;
}

function joinStats(
    mcmod: readonly McmodEntry[],
    modrinth: readonly ModrinthProject[],
    rows: ReadonlyMap<string, string>,
): string {
    return `# 统计：MC百科 ${mcmod.length} 条，Modrinth ${modrinth.length} 条，匹配 ${rows.size} 条`;
}

/* ---------- 选项 ---------- */

function parseArgs(argv: readonly string[]): Options {
    const options: Options = {
        pages: null,
        modrinthPages: null,
        delay: DEFAULT_DELAY,
        apiDelay: DEFAULT_API_DELAY,
        refresh: false,
        dryRun: false,
        cache: DEFAULT_CACHE,
        out: DEFAULT_OUT,
    };
    const mutable = options as {
        pages: number | null;
        modrinthPages: number | null;
        delay: number;
        apiDelay: number;
        refresh: boolean;
        dryRun: boolean;
        cache: string;
        out: string;
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = (): string => {
            index += 1;
            const value = argv[index];
            if (value === undefined) {
                throw new Error(`${arg} 缺参数`);
            }
            return value;
        };
        switch (arg) {
            case "--pages":
                mutable.pages = Number(next());
                break;
            case "--modrinth-pages":
                mutable.modrinthPages = Number(next());
                break;
            case "--delay":
                mutable.delay = Number(next());
                break;
            case "--api-delay":
                mutable.apiDelay = Number(next());
                break;
            case "--cache":
                mutable.cache = next();
                break;
            case "--out":
                mutable.out = next();
                break;
            case "--refresh":
                mutable.refresh = true;
                break;
            case "--dry-run":
                mutable.dryRun = true;
                break;
            default:
                throw new Error(`未知参数：${arg}`);
        }
    }
    return options;
}

/* ---------- 杂项 ---------- */

function decodeEntities(text: string): string {
    return text
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)));
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

await main();
