/**
 * 状态文件
 *
 * 内存里累计，退出前写一次；统计丢了无所谓，所以坏文件直接删掉重建
 * @author IsCibocaz
 * @since 1.0.0
 */

import { rm } from "node:fs/promises";

import { readText, writeAtomic } from "../infra/fs.ts";
import { logger } from "../output/index.ts";
import { stateFile } from "../platform/index.ts";
import { defaultState } from "./defaults.ts";
import { object, parseJson, reader } from "./read.ts";
import { CURRENT_SCHEMA, type InstanceStat, type JavaProbe, type State } from "./types.ts";

const log = logger("config");
// 统计的键是 <文件夹 id>/<实例 id>
const STAT_KEY = /^[^/]+\/[^/]+$/;

let cache: State | undefined;
let dirty = false;

// 首次调用读盘，之后返回内存里那份
export async function loadState(): Promise<State> {
    if (cache === undefined) {
        cache = await read();
        dirty = false;
    }
    return cache;
}

export async function updateState(change: (state: State) => State): Promise<State> {
    cache = change(await loadState());
    dirty = true;
    return cache;
}

// 没改过就不写盘
export async function flushState(): Promise<void> {
    if (cache === undefined || !dirty) {
        return;
    }
    await writeAtomic(stateFile(), `${JSON.stringify(cache, null, 4)}\n`);
    dirty = false;
}

async function read(): Promise<State> {
    const path = stateFile();
    const text = await readText(path);
    if (text === undefined) {
        return defaultState();
    }

    const parsed = object(parseJson(text, path), path);
    if (parsed === undefined) {
        log.warn("%s 读不出来，已删掉重建", path);
        await rm(path, { force: true }).catch(() => {});
        return defaultState();
    }

    const extras: string[] = [];
    const r = reader("state", parsed, extras);
    const lastFolder = r.nullableString("lastFolder", null);
    const lastInstance = r.nullableString("lastInstance", null);
    const instances: Record<string, InstanceStat> = {
        ...r.map<InstanceStat>("instances", {}, readStat),
    };
    const javaProbe = r.map<JavaProbe>("javaProbe", {}, readProbe);
    r.extra();

    for (const key of Object.keys(instances)) {
        if (!STAT_KEY.test(key)) {
            log.warn("state.instances 的键 %s 不是 <文件夹>/<实例>，已丢弃", key);
            delete instances[key];
        }
    }
    return { schemaVersion: CURRENT_SCHEMA, lastFolder, lastInstance, instances, javaProbe };
}

function readStat(value: unknown, at: string): InstanceStat | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, []);
    const stat: InstanceStat = {
        lastPlayedAt: r.nullableString("lastPlayedAt", null),
        playTimeMinutes: r.integer("playTimeMinutes", 0, 0),
        launchCount: r.integer("launchCount", 0, 0),
    };
    r.extra();
    return stat;
}

function readProbe(value: unknown, at: string): JavaProbe | undefined {
    const raw = object(value, at);
    if (raw === undefined) {
        return undefined;
    }
    const r = reader(at, raw, []);
    const probe: JavaProbe = {
        major: r.optionalInteger("major", 1) ?? null,
        arch: r.enumeration("arch", ["x64", "x86", "arm64", "arm"] as const, "x64"),
        vendor: r.nullableString("vendor", null),
        probedAt: r.string("probedAt", ""),
    };
    r.extra();
    // 没有探测时间的缓存没用
    return probe.probedAt === "" ? undefined : probe;
}
