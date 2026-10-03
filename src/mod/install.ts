/**
 * MOD 安装
 *
 * 目标实例的游戏版本与加载器决定装哪一版，文件落到实例自己的 mods/
 * required 依赖递归装上，同名文件已存在就跳过
 * @author IsCibocaz
 * @since 1.1.6
 */

import { join } from "node:path";

import { AppError } from "../error/index.ts";
import { pathExists } from "../infra/fs.ts";
import { downloadOne, type TransferOptions } from "../infra/download.ts";
import { logger } from "../output/index.ts";
import {
    listVersions,
    pickVersion,
    projectOf,
    searchMods,
    versionOfId,
    type ModHit,
    type ModVersion,
    type ModrinthInput,
    type Transport,
} from "./modrinth.ts";

const log = logger("mod");

// Modrinth 的 slug 与项目 id 都是这套字符
const SLUG = /^[a-z0-9][a-z0-9-_]{0,63}$/;

// 依赖往下走两层够了，再深基本都是可选件
const MAX_DEPTH = 2;

export interface InstalledFile {
    readonly projectId: string;
    readonly title: string;
    readonly filename: string;
    readonly path: string;
    readonly size: number;
    readonly version: string;
    readonly skipped: boolean;
}

/** required 之外的依赖只记录，装着看用户 */
export interface DependencyNote {
    readonly projectId: string | null;
    readonly type: string;
    readonly title: string | null;
    readonly requirement: string;
}

export interface ModInstallReport {
    readonly project: { readonly id: string; readonly slug: string; readonly title: string };
    readonly version: {
        readonly id: string;
        readonly number: string;
        readonly type: string;
        readonly gameVersions: readonly string[];
        readonly loaders: readonly string[];
    };
    readonly files: readonly InstalledFile[];
    readonly dependencies: readonly DependencyNote[];
    readonly warnings: readonly string[];
}

export interface ModInstallInput {
    /** slug、项目 id 或搜索词 */
    readonly query: string;
    /** 实例自己的 mods/ */
    readonly modsDirectory: string;
    readonly gameVersion: string | null;
    readonly loader: string | null;
    readonly network: TransferOptions;
    readonly withDependencies: boolean;
    readonly dryRun?: boolean;
    readonly transport?: Transport;
    readonly download?: typeof downloadOne;
}

/** MOD 只能装到加载器实例上，加载器与游戏版本都认出来才算 */
export function requireModTarget(
    loader: string | null | undefined,
    gameVersion: string | null | undefined,
): { loader: string; gameVersion: string } {
    if (loader === null || loader === undefined) {
        throw new AppError("mod", "ModUnsupported", {
            context: { detail: "这个版本不是加载器版本，MOD 装进去不会加载" },
        });
    }
    if (gameVersion === null || gameVersion === undefined) {
        throw new AppError("mod", "ModUnsupported", {
            context: { detail: "认不出这个实例对应的游戏版本" },
        });
    }
    return { loader, gameVersion };
}

export async function installMod(input: ModInstallInput): Promise<ModInstallReport> {
    const api: ModrinthInput = { network: input.network, transport: input.transport };
    const { loader, gameVersion } = requireModTarget(input.loader, input.gameVersion);

    const project = await resolveProject(input.query, api);
    const version = await matchVersion(project.id, { loader, gameVersion }, api);
    const context: WalkContext = {
        input,
        api,
        loader,
        gameVersion,
        files: [],
        dependencies: [],
        warnings: [],
        seen: new Set([project.id]),
    };

    await installOne(project, version, context, 0);

    log.info("装了 %s：%d 个文件", project.slug, context.files.length);
    return {
        project: { id: project.id, slug: project.slug, title: project.title },
        version: {
            id: version.id,
            number: version.versionNumber,
            type: version.versionType,
            gameVersions: version.gameVersions,
            loaders: version.loaders,
        },
        files: context.files,
        dependencies: context.dependencies,
        warnings: context.warnings,
    };
}

/* ---------- 内部 ---------- */

interface WalkContext {
    readonly input: ModInstallInput;
    readonly api: ModrinthInput;
    readonly loader: string;
    readonly gameVersion: string;
    readonly files: InstalledFile[];
    readonly dependencies: DependencyNote[];
    readonly warnings: string[];
    readonly seen: Set<string>;
}

// slug 直接取项目，取不到再退回搜索，用第一条
async function resolveProject(query: string, api: ModrinthInput): Promise<ModHit> {
    if (SLUG.test(query)) {
        const direct = await projectOf(query, api);
        if (direct !== undefined) {
            return direct;
        }
    }

    const hits = await searchMods(query, api);
    const first = hits[0];
    if (first === undefined) {
        throw new AppError("mod", "ModNotFound", { context: { detail: query } });
    }
    log.debug("%s 命中 %s（%s）", query, first.title, first.slug);
    return first;
}

async function matchVersion(
    projectId: string,
    filter: { readonly loader: string; readonly gameVersion: string },
    api: ModrinthInput,
): Promise<ModVersion> {
    const versions = await listVersions(projectId, filter, api);
    const version = pickVersion(versions);
    if (version === undefined || version.file === null) {
        throw new AppError("mod", "ModUnsupported", {
            context: {
                detail: `没有同时支持 ${filter.gameVersion} 与 ${filter.loader} 的版本`,
                project: projectId,
            },
        });
    }
    return version;
}

async function installOne(
    project: ModHit,
    version: ModVersion,
    context: WalkContext,
    depth: number,
): Promise<void> {
    const file = version.file;
    if (file === null) {
        context.warnings.push(`${project.title} 这一版没有可下载文件`);
        return;
    }

    const target = join(context.input.modsDirectory, file.filename);
    const existed = await pathExists(target);
    if (context.input.dryRun !== true) {
        const download = context.input.download ?? downloadOne;
        const outcome = await download(
            {
                url: file.url,
                target,
                sha1: file.sha1,
                size: file.size,
            },
            context.input.network,
        );
        context.files.push({
            projectId: project.id,
            title: project.title,
            filename: file.filename,
            path: outcome.target,
            size: file.size,
            version: version.versionNumber,
            skipped: outcome.status === "skipped",
        });
    } else {
        context.files.push({
            projectId: project.id,
            title: project.title,
            filename: file.filename,
            path: target,
            size: file.size,
            version: version.versionNumber,
            skipped: existed,
        });
    }

    if (depth >= MAX_DEPTH) {
        return;
    }

    for (const dependency of version.dependencies) {
        if (dependency.projectId === null) {
            continue;
        }
        if (dependency.type !== "required") {
            context.dependencies.push({
                projectId: dependency.projectId,
                type: dependency.type,
                title: null,
                requirement: dependency.type === "optional" ? "可选" : dependency.type,
            });
            continue;
        }
        if (context.seen.has(dependency.projectId)) {
            continue;
        }
        context.seen.add(dependency.projectId);

        if (context.input.withDependencies !== true) {
            context.dependencies.push({
                projectId: dependency.projectId,
                type: dependency.type,
                title: null,
                requirement: "必需，加 --deps 一起装",
            });
            continue;
        }

        const filter = { loader: context.loader, gameVersion: context.gameVersion };
        const dependencyProject = await projectOf(dependency.projectId, context.api);
        const dependencyVersion =
            dependency.versionId !== null
                ? await versionOfId(dependency.versionId, context.api)
                : await matchVersion(dependency.projectId, filter, context.api).catch(
                      () => undefined,
                  );
        if (dependencyProject === undefined || dependencyVersion === undefined) {
            context.warnings.push(`依赖 ${dependency.projectId} 取不到，跳过`);
            continue;
        }
        context.dependencies.push({
            projectId: dependency.projectId,
            type: dependency.type,
            title: dependencyProject.title,
            requirement: "必需，已装",
        });
        await installOne(dependencyProject, dependencyVersion, context, depth + 1);
    }
}
