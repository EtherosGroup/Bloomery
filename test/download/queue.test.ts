/**
 * 下载队列：状态流转、锁、崩溃回收、节流
 * @author IsCibocaz
 * @since 1.11.0
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
    acquireLock,
    cancelTask,
    clearFinished,
    enqueue,
    lockHolderOf,
    patchTask,
    progressThrottle,
    readQueue,
    recoverRunning,
    retryTask,
    stamp,
    taskErrorOf,
    workOffQueue,
    type EnqueueInput,
    type ModInstallParams,
    type WorkerOptions,
} from "../../src/download/index.ts";
import { AppError } from "../../src/error/index.ts";

const PARAMS: ModInstallParams = {
    query: "sodium",
    modsDirectory: "/tmp/mods",
    gameVersion: "1.20.1",
    loader: "fabric",
    withDependencies: true,
    dryRun: false,
};

function input(query = "sodium"): EnqueueInput {
    return { type: "mod-install", target: query, params: { ...PARAMS, query } };
}

async function scratch(): Promise<{ dir: string; queue: string; lock: string; cancel: string }> {
    const dir = await mkdtemp(join(tmpdir(), "bloomery-queue-"));
    return {
        dir,
        queue: join(dir, "downloads.json"),
        lock: join(dir, "downloads.lock"),
        cancel: join(dir, "downloads.cancel"),
    };
}

test("入队给 pending，读回来字段齐", async () => {
    const { dir, queue } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        assert.equal(task.state, "pending");
        assert.equal(task.attempts, 0);
        assert.equal(task.started, null);
        assert.equal(task.target, "sodium");
        assert.match(task.created, /^\d{4}-\d{2}-\d{2}T.*Z$/);

        const back = await readQueue(queue);
        assert.equal(back.tasks.length, 1);
        assert.equal(back.tasks[0]?.id, task.id);
        assert.equal(back.tasks[0]?.params.loader, "fabric");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("队列文件不存在时按空队列处理", async () => {
    const { dir, queue } = await scratch();
    try {
        const empty = await readQueue(queue);
        assert.deepEqual(empty.tasks, []);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("两次入队 id 不重复", async () => {
    const { dir, queue } = await scratch();
    try {
        const one = await enqueue(input("a"), queue);
        const two = await enqueue(input("b"), queue);
        assert.notEqual(one.id, two.id);
        assert.equal((await readQueue(queue)).tasks.length, 2);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("patchTask 打不中 id 时给 undefined", async () => {
    const { dir, queue } = await scratch();
    try {
        await enqueue(input(), queue);
        assert.equal(await patchTask("nope", { state: "done" }, queue), undefined);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("retry 只接 failed", async () => {
    const { dir, queue } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        await assert.rejects(
            () => retryTask(task.id, queue),
            (error: unknown) => {
                return error instanceof AppError && error.code === "UsageError";
            },
        );

        await patchTask(task.id, { state: "failed" }, queue);
        const again = await retryTask(task.id, queue);
        assert.equal(again.state, "pending");
        assert.equal(again.error, null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("retry 找不到任务时报 TaskNotFound", async () => {
    const { dir, queue } = await scratch();
    try {
        await assert.rejects(
            () => retryTask("nope", queue),
            (error: unknown) => {
                return error instanceof AppError && error.code === "TaskNotFound";
            },
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("cancel：pending 直接标取消，并留下中止标记", async () => {
    const { dir, queue, cancel } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        const result = await cancelTask(task.id, queue, cancel);
        assert.equal(result.outcome, "cancelled");
        assert.equal(result.task.state, "cancelled");

        const requests = JSON.parse(await readFile(cancel, "utf8")) as string[];
        assert.deepEqual(requests, [task.id]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("cancel：running 给中止请求，状态留给 worker 收", async () => {
    const { dir, queue, cancel } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        await patchTask(task.id, { state: "running" }, queue);
        const result = await cancelTask(task.id, queue, cancel);
        assert.equal(result.outcome, "aborting");
        assert.equal((await readQueue(queue)).tasks[0]?.state, "running");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("cancel：终态直接报用法", async () => {
    const { dir, queue, cancel } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        await patchTask(task.id, { state: "done" }, queue);
        await assert.rejects(
            () => cancelTask(task.id, queue, cancel),
            (error: unknown) => {
                return error instanceof AppError && error.code === "UsageError";
            },
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("clearFinished 只清终态", async () => {
    const { dir, queue } = await scratch();
    try {
        const done = await enqueue(input("done"), queue);
        const running = await enqueue(input("running"), queue);
        const pending = await enqueue(input("pending"), queue);
        await patchTask(done.id, { state: "done" }, queue);
        await patchTask(running.id, { state: "running" }, queue);

        // running 不是终态，不在此列
        assert.equal(await clearFinished(queue), 1);
        const left = (await readQueue(queue)).tasks.map((task) => task.target);
        assert.deepEqual([...left].sort(), ["pending", "running"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("recoverRunning 把遗留的 running 标成 failed 并保留次数", async () => {
    const { dir, queue } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        await patchTask(task.id, { state: "running", attempts: 3 }, queue);

        const recovered = await recoverRunning(queue, stamp());
        assert.deepEqual(recovered, [task.id]);
        const back = (await readQueue(queue)).tasks[0];
        assert.equal(back?.state, "failed");
        assert.equal(back?.attempts, 3);
        assert.equal(back?.error?.retryable, true);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("锁：活进程占着时报 WorkerBusy", async () => {
    const { dir, lock } = await scratch();
    try {
        await writeFile(lock, `${process.pid}\n`);
        await assert.rejects(
            () => acquireLock(lock),
            (error: unknown) => {
                return error instanceof AppError && error.code === "WorkerBusy";
            },
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("锁：残留死 pid 会被清掉再抢到", async () => {
    const { dir, lock } = await scratch();
    try {
        await writeFile(lock, "4194303\n");
        const held = await acquireLock(lock);
        assert.equal(held.pid, process.pid);
        await held.release();
        assert.equal(await lockHolderOf(lock), null);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("锁：release 之后别人能抢到", async () => {
    const { dir, lock } = await scratch();
    try {
        const first = await acquireLock(lock);
        await first.release();
        const second = await acquireLock(lock);
        assert.equal(second.pid, process.pid);
        await second.release();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("节流：间隔内不给，强制与到点给", async () => {
    let now = 1000;
    const allowed = progressThrottle(1000, () => now);
    assert.equal(allowed(), true);
    assert.equal(allowed(), false);
    assert.equal(allowed(true), true);
    now += 1000;
    assert.equal(allowed(), true);
});

test("taskErrorOf：AppError 带出码、detail 与可重试", async () => {
    const failure = taskErrorOf(
        new AppError("download", "DownloadFailed", { context: { detail: "断网" } }),
    );
    assert.equal(failure.code, "DownloadFailed");
    assert.equal(failure.detail, "断网");
    assert.equal(failure.retryable, true);

    const other = taskErrorOf(new Error("炸了"));
    assert.equal(other.code, "UnknownError");
    assert.equal(other.retryable, false);
});

test("worker：跑完一个任务写回 done 与进度", async () => {
    const { dir, queue, lock, cancel } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        const options: WorkerOptions = {
            queuePath: queue,
            lockPath: lock,
            cancelPath: cancel,
            intervalMs: 0,
            run: async (one, control) => {
                control.progress("文件", 5, 10, false);
            },
        };
        const report = await workOffQueue(options);
        assert.equal(report.done, 1);
        assert.equal(report.tasks[0]?.id, task.id);

        const back = (await readQueue(queue)).tasks[0];
        assert.equal(back?.state, "done");
        assert.equal(back?.attempts, 1);
        assert.equal(back?.progress?.done, 5);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("worker：执行器抛错记 failed，可重试的照实记", async () => {
    const { dir, queue, lock, cancel } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        const report = await workOffQueue({
            queuePath: queue,
            lockPath: lock,
            cancelPath: cancel,
            run: async () => {
                throw new AppError("download", "DownloadFailed", { context: { detail: "超时" } });
            },
        });
        assert.equal(report.failed, 1);
        const back = (await readQueue(queue)).tasks[0];
        assert.equal(back?.state, "failed");
        assert.equal(back?.error?.code, "DownloadFailed");
        assert.equal(back?.error?.retryable, true);
        assert.equal(task.attempts, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("worker：中止标记让 pending 任务不入跑", async () => {
    const { dir, queue, lock, cancel } = await scratch();
    try {
        const task = await enqueue(input(), queue);
        await writeFile(cancel, JSON.stringify([task.id]));
        let ran = false;
        const report = await workOffQueue({
            queuePath: queue,
            lockPath: lock,
            cancelPath: cancel,
            run: async () => {
                ran = true;
            },
        });
        assert.equal(ran, false);
        assert.equal(report.cancelled, 1);
        assert.equal((await readQueue(queue)).tasks[0]?.state, "cancelled");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("worker：先回收上一次的 running，再跑 pending", async () => {
    const { dir, queue, lock, cancel } = await scratch();
    try {
        const stale = await enqueue(input("stale"), queue);
        const fresh = await enqueue(input("fresh"), queue);
        await patchTask(stale.id, { state: "running" }, queue);

        const report = await workOffQueue({
            queuePath: queue,
            lockPath: lock,
            cancelPath: cancel,
            run: async () => undefined,
        });
        assert.deepEqual(report.recovered, [stale.id]);
        assert.equal(report.done, 1);
        const states = (await readQueue(queue)).tasks.map((task) => task.state);
        assert.deepEqual([...states].sort(), ["done", "failed"]);
        assert.equal((await readQueue(queue)).tasks[0]?.id, stale.id);
        assert.equal(fresh.state, "pending");
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
