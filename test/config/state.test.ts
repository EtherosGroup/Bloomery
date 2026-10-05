/**
 * 状态文件：退出前重读再重放，多个进程共用数据目录时统计不丢
 * @author IsCibocaz
 * @since 1.12.0
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { flushState, loadState, updateState } from "../../src/config/state.ts";
import { setHome, stateFile } from "../../src/platform/index.ts";
import type { State } from "../../src/config/types.ts";

const KEY = "f/i";

// 与 launch 里那条一样：按当前值加一
function bump(state: State): State {
    return {
        ...state,
        instances: {
            ...state.instances,
            [KEY]: {
                lastPlayedAt: "2026-10-04T00:00:00.000Z",
                playTimeMinutes: state.instances[KEY]?.playTimeMinutes ?? 0,
                launchCount: (state.instances[KEY]?.launchCount ?? 0) + 1,
            },
        },
    };
}

function countIn(path: string): number {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
        instances: Record<string, { launchCount: number }>;
    };
    return parsed.instances[KEY]?.launchCount ?? 0;
}

test("退出前重读：别的进程刚写过的统计不被这次覆盖", async () => {
    const home = mkdtempSync(join(tmpdir(), "bloomery-state-"));
    try {
        setHome(home);
        await loadState();
        await updateState(bump);

        // 另一个进程在这期间写了一份
        mkdirSync(join(home, ".config", "bloomery"), { recursive: true });
        writeFileSync(
            stateFile(),
            `${JSON.stringify({
                schemaVersion: 1,
                lastFolder: null,
                lastInstance: null,
                instances: { [KEY]: { lastPlayedAt: null, playTimeMinutes: 0, launchCount: 5 } },
                javaProbe: {},
            })}\n`,
        );

        await flushState();
        assert.equal(countIn(stateFile()), 6);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("两个进程并发启动各加一次，结果等于 2", async () => {
    const home = mkdtempSync(join(tmpdir(), "bloomery-state-"));
    // 子进程按 HOME 找数据目录，本进程按 setHome
    setHome(home);
    const module = fileURLToPath(new URL("../../src/config/state.ts", import.meta.url));
    const script = `
import { loadState, updateState, flushState } from ${JSON.stringify(module)};
const key = ${JSON.stringify(KEY)};
await loadState();
await updateState((state) => ({
    ...state,
    instances: {
        ...state.instances,
        [key]: {
            lastPlayedAt: "2026-10-04T00:00:00.000Z",
            playTimeMinutes: state.instances[key]?.playTimeMinutes ?? 0,
            launchCount: (state.instances[key]?.launchCount ?? 0) + 1,
        },
    },
}));
// 两个进程的读改写窗口重叠
await new Promise((resolve) => setTimeout(resolve, 80));
await flushState();
`;

    const run = (): Promise<number | null> =>
        new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
                env: { ...process.env, HOME: home },
                stdio: ["ignore", "ignore", "pipe"],
            });
            let stderr = "";
            child.stderr.on("data", (chunk: Buffer) => {
                stderr += chunk.toString();
            });
            child.on("error", reject);
            child.on("close", (code) => {
                if (code !== 0) {
                    reject(new Error(`子进程退出码 ${code}：${stderr}`));
                    return;
                }
                resolve(code);
            });
        });

    try {
        await Promise.all([run(), run()]);
        assert.equal(countIn(stateFile()), 2);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
