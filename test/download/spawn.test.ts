/**
 * 后台 worker 的拉起：替身起进程、pid 锁去重、日志追加
 * @author IsCibocaz
 * @since 1.11.0
 */

import assert from "node:assert/strict";
import { writeSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { SpawnOptions } from "node:child_process";

import {
    NO_WORKER_ENV,
    startWorker,
    WORKER_LOG_FILE,
    type SpawnDetached,
    type WorkerStart,
} from "../../src/download/index.ts";

interface Call {
    readonly execPath: string;
    readonly argv: readonly string[];
    readonly options: SpawnOptions;
}

async function scratch(): Promise<{ dir: string; lock: string; log: string }> {
    const dir = await mkdtemp(join(tmpdir(), "bloomery-spawn-"));
    return { dir, lock: join(dir, "downloads.lock"), log: join(dir, "logs", WORKER_LOG_FILE) };
}

test("拉起：子进程跑 download run，unref 被调，日志建好并追加", async () => {
    const { dir, lock, log } = await scratch();
    try {
        // 已有日志内容：这轮追加不截断
        await mkdir(dirname(log), { recursive: true });
        await writeFile(log, "# worker 上一轮\n");

        const calls: Call[] = [];
        let unreffed = false;
        const spawn: SpawnDetached = (execPath, argv, options) => {
            calls.push({ execPath, argv, options });
            const stdio = options.stdio;
            const fd = Array.isArray(stdio) ? stdio[1] : undefined;
            if (typeof fd === "number") {
                writeSync(fd, "子进程的一行\n");
            }
            return {
                pid: 4242,
                unref: (): void => {
                    unreffed = true;
                },
            };
        };

        const start = await startWorker({
            lockPath: lock,
            logPath: log,
            spawn,
            entry: "/opt/bloomery/dist/main.js",
            task: "0f3a1b2c",
            at: Date.UTC(2025, 0, 2, 3, 4, 5),
        });

        assert.equal(start.outcome, "started");
        assert.equal(start.pid, 4242);
        assert.equal(start.worker, null);
        assert.equal(start.log, log);
        assert.ok(unreffed, "unref 未调用");

        const [call] = calls;
        assert.equal(call?.execPath, process.execPath);
        assert.deepEqual(call?.argv.slice(0, 2), ["/opt/bloomery/dist/main.js", "--progress"]);
        assert.deepEqual(call?.argv.slice(2), ["off", "download", "run"]);
        assert.equal(call?.options.detached, true);
        assert.equal(call?.options.windowsHide, true);
        // stdio 走文件 fd，管道会把调用方 stdout 吊住
        const stdio = call?.options.stdio;
        assert.ok(Array.isArray(stdio));
        const fd = stdio[1];
        assert.equal(stdio[0], "ignore");
        assert.equal(typeof fd, "number");
        assert.equal(fd, stdio[2]);
        assert.ok(typeof fd === "number" && fd >= 0);

        const text = await readFile(log, "utf8");
        assert.ok(text.includes("# worker 上一轮"), "旧内容被覆盖了，追加写没生效");
        assert.ok(text.includes("# worker 2025-01-02T03:04:05.000Z"));
        assert.ok(text.includes(`parent ${process.pid}`));
        assert.ok(text.includes("task 0f3a1b2c"));
        assert.ok(text.includes("子进程的一行"));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("拉起：--home 透传给子进程，且写在命令名之前", async () => {
    const { dir, lock, log } = await scratch();
    try {
        const calls: Call[] = [];
        const spawn: SpawnDetached = (execPath, argv, options) => {
            calls.push({ execPath, argv, options });
            return { pid: 7, unref: (): void => {} };
        };
        await startWorker({
            lockPath: lock,
            logPath: log,
            spawn,
            home: "/data/bloomery",
            entry: "/opt/bloomery/dist/main.js",
        });
        assert.deepEqual(calls[0]?.argv, [
            "/opt/bloomery/dist/main.js",
            "--home",
            "/data/bloomery",
            "--progress",
            "off",
            "download",
            "run",
        ]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("已有 worker 拿着锁时不再拉起", async () => {
    const { dir, lock, log } = await scratch();
    try {
        await writeFile(lock, `${process.pid}\n`);
        let spawned = false;
        const start = await startWorker({
            lockPath: lock,
            logPath: log,
            entry: "/opt/bloomery/dist/main.js",
            spawn: () => {
                spawned = true;
                return { pid: 1, unref: (): void => {} };
            },
        });
        assert.equal(start.outcome, "busy");
        assert.equal(start.worker, process.pid);
        assert.equal(start.pid, null);
        assert.equal(spawned, false, "已有 worker 时起进程");
        await assert.rejects(() => readFile(log, "utf8"), "busy 时建了日志");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("残留死 pid 的锁不挡拉起", async () => {
    const { dir, lock, log } = await scratch();
    try {
        await writeFile(lock, "4194303\n");
        const start = await startWorker({
            lockPath: lock,
            logPath: log,
            entry: "/opt/bloomery/dist/main.js",
            spawn: () => ({ pid: 5, unref: (): void => {} }),
        });
        assert.equal(start.outcome, "started");
        assert.equal(start.pid, 5);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("环境开关跳过后台拉起", async () => {
    const { dir, lock, log } = await scratch();
    try {
        let spawned = false;
        const start = await startWorker({
            lockPath: lock,
            logPath: log,
            entry: "/opt/bloomery/dist/main.js",
            env: { [NO_WORKER_ENV]: "1" },
            spawn: () => {
                spawned = true;
                return { pid: 1, unref: (): void => {} };
            },
        });
        assert.equal(start.outcome, "disabled");
        assert.equal(spawned, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("入口不可用时不起进程", async () => {
    const { dir, lock, log } = await scratch();
    try {
        let spawned = false;
        const start: WorkerStart = await startWorker({
            lockPath: lock,
            logPath: log,
            entry: "",
            spawn: () => {
                spawned = true;
                return { pid: 1, unref: (): void => {} };
            },
        });
        assert.equal(start.outcome, "unavailable");
        assert.equal(start.detail, "入口路径不可用");
        assert.equal(spawned, false);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("起进程失败报 failed", async () => {
    const { dir, lock, log } = await scratch();
    try {
        const start = await startWorker({
            lockPath: lock,
            logPath: log,
            entry: "/opt/bloomery/dist/main.js",
            spawn: () => {
                throw new Error("spawn EACCES /opt/bloomery/dist/main.js");
            },
        });
        assert.equal(start.outcome, "failed");
        assert.match(start.detail ?? "", /EACCES/);
        assert.equal(start.pid, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("子进程 pid 缺失时报 failed", async () => {
    const { dir, lock, log } = await scratch();
    try {
        const start = await startWorker({
            lockPath: lock,
            logPath: log,
            entry: "/opt/bloomery/dist/main.js",
            spawn: () => ({ unref: (): void => {} }),
        });
        assert.equal(start.outcome, "failed");
        assert.equal(start.detail, "子进程创建失败");
        assert.equal(start.pid, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
