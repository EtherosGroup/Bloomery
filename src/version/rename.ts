/**
 * 版本改名
 *
 * 目录名即实例 id，json 文件名与 jar 文件名都跟着目录名走
 * json 里的 id 是游戏版本号，改名不动它
 * 别的版本靠 inheritsFrom 或 jar 指向这个目录名，改名时必须一起改写，否则继承链断掉
 * @author IsCibocaz
 * @since 1.12.0
 */

import { readdir, rename } from "node:fs/promises";
import { join } from "node:path";

import { object, parseJson } from "../config/read.ts";
import { AppError } from "../error/index.ts";
import { pathExists, readText, writeAtomic } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import { scanVersions, type LocalVersion } from "./store.ts";

const log = logger("version");

/** 名字里不能出现的字符：路径分隔与 Windows 保留字符 */
const FORBIDDEN = /[/\\<>:"|?*]/;

export interface RenameInput {
    readonly folderPath: string;
    readonly from: string;
    readonly to: string;
    readonly dryRun?: boolean | undefined;
}

export interface RenameReport {
    readonly from: string;
    readonly to: string;
    /** versions/<新名字> */
    readonly directory: string;
    /** 被改写引用的实例 id */
    readonly rewritten: readonly string[];
}

// 新名字：去首尾空白，不能为空，不能带路径分隔、保留字符或控制字符
export function versionNameOf(raw: string): string {
    const name = raw.trim();
    const control = [...name].some((char) => {
        const code = char.codePointAt(0) ?? 0;
        return code < 32 || code === 127;
    });
    if (name === "" || name === "." || name === ".." || FORBIDDEN.test(name) || control) {
        throw new AppError("cli", "UsageError", { context: { detail: `实例名不合法：${raw}` } });
    }
    return name;
}

export async function renameVersion(input: RenameInput): Promise<RenameReport> {
    const versionsRoot = join(input.folderPath, "versions");
    const source = join(versionsRoot, input.from);
    const target = join(versionsRoot, input.to);

    if (!(await pathExists(source))) {
        throw new AppError("cli", "VersionNotFound", {
            context: { detail: input.from, folder: input.folderPath },
        });
    }
    if (await pathExists(target)) {
        throw new AppError("cli", "VersionExists", { context: { detail: input.to } });
    }

    // 引用先收齐：改完名再扫就认不出谁指向谁了
    const scan = await scanVersions(input.folderPath);
    const holders = await referenceHolders(scan.versions, input.from);
    const report: RenameReport = {
        from: input.from,
        to: input.to,
        directory: target,
        rewritten: holders.map((version) => version.id).sort(),
    };
    if (input.dryRun === true) {
        return report;
    }

    await rename(source, target);
    await renameArtifacts(target, input.from, input.to);
    for (const version of holders) {
        await rewriteReferences(version.json, input.from, input.to);
    }
    log.info("版本 %s 改名 %s，改写 %d 处引用", input.from, input.to, holders.length);
    return report;
}

// 目录里的 json 与 jar 跟着目录名走
async function renameArtifacts(directory: string, from: string, to: string): Promise<void> {
    const fromJar = join(directory, `${from}.jar`);
    if (await pathExists(fromJar)) {
        await rename(fromJar, join(directory, `${to}.jar`));
    }

    // json 文件名跟随目录名；第三方安装器写过别的名字时保持原样
    const fromJson = join(directory, `${from}.json`);
    let jsonPath: string;
    if (await pathExists(fromJson)) {
        jsonPath = join(directory, `${to}.json`);
        await rename(fromJson, jsonPath);
    } else {
        const only = await onlyJson(directory);
        if (only === null) {
            return;
        }
        jsonPath = only;
    }

    const data = await readJson(jsonPath);
    const jar = data?.["jar"];
    if (data !== null && (jar === from || jar === `${from}.jar`)) {
        data["jar"] = to;
        await writeAtomic(jsonPath, `${JSON.stringify(data, null, 4)}\n`);
    }
}

// 别的版本里指向 from 的地方：inheritsFrom 与 jar 都按目录名认
async function referenceHolders(
    versions: readonly LocalVersion[],
    from: string,
): Promise<LocalVersion[]> {
    const holders: LocalVersion[] = [];
    for (const version of versions) {
        if (version.id === from) {
            continue;
        }
        const data = await readJson(version.json);
        if (data === null) {
            continue;
        }
        if (data["inheritsFrom"] === from || data["jar"] === from) {
            holders.push(version);
        }
    }
    return holders;
}

async function rewriteReferences(jsonPath: string, from: string, to: string): Promise<void> {
    const data = await readJson(jsonPath);
    if (data === null) {
        return;
    }
    if (data["inheritsFrom"] === from) {
        data["inheritsFrom"] = to;
    }
    if (data["jar"] === from) {
        data["jar"] = to;
    }
    await writeAtomic(jsonPath, `${JSON.stringify(data, null, 4)}\n`);
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
    const text = await readText(path);
    if (text === undefined) {
        return null;
    }
    return object(parseJson(text, path), path) ?? null;
}

// 目录里唯一的 .json，与 store 的退路一致
async function onlyJson(directory: string): Promise<string | null> {
    const names = await readdir(directory).catch(() => [] as string[]);
    const candidates = names.filter((name) => name.toLowerCase().endsWith(".json"));
    const only = candidates[0];
    return candidates.length === 1 && only !== undefined ? join(directory, only) : null;
}
