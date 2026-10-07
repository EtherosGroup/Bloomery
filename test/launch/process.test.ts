/**
 * 游戏进程：退出码带回、启动失败与 detach 解绑
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { spawnGame } from "../../src/launch/process.ts";

test("退出码原样带出", async () => {
    const code = await spawnGame(process.execPath, ["-e", "process.exit(7)"], process.cwd()).done;
    assert.equal(code, 7);
});

test("正常结束是 0", async () => {
    const code = await spawnGame(process.execPath, ["-e", ""], process.cwd()).done;
    assert.equal(code, 0);
});

test("起不来的可执行文件报错", async () => {
    const game = spawnGame("/没有这个可执行文件", [], process.cwd());
    await assert.rejects(game.done, (error: unknown) => {
        return (error as { code?: string }).code === "LaunchFailed";
    });
});

// Linux 上 detached 走 setsid，Windows 上走 DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
// 会话号由子进程自己报：父进程读 /proc/<pid>/stat 会撞上 fork 与 setsid 之间的窗口
// stat 从 comm 的右括号之后起数：state ppid pgrp session
function sessionReporter(target: string): string[] {
    return [
        "-e",
        "const fs = require('node:fs');" +
            "const s = fs.readFileSync('/proc/self/stat', 'utf8');" +
            "fs.writeFileSync(process.argv[1], s.slice(s.lastIndexOf(')') + 2).split(' ')[3]);",
        target,
    ];
}

test("不等游戏退出时子进程自成会话", { skip: process.platform !== "linux" }, async () => {
    const log = join(tmpdir(), `bloomery-detach-${process.pid}.log`);
    const sid = join(tmpdir(), `bloomery-detach-sid-${process.pid}.txt`);
    const game = spawnGame(process.execPath, sessionReporter(sid), process.cwd(), {
        logFile: log,
        unref: true,
    });
    assert.notEqual(game.pid, undefined);

    await game.done;
    assert.equal(readFileSync(sid, "utf8"), String(game.pid));

    rmSync(log, { force: true });
    rmSync(sid, { force: true });
});

test("不给日志文件时子进程同样自成会话", { skip: process.platform !== "linux" }, async () => {
    const sid = join(tmpdir(), `bloomery-detach-inherit-${process.pid}.txt`);
    const game = spawnGame(process.execPath, sessionReporter(sid), process.cwd(), { unref: true });
    assert.notEqual(game.pid, undefined);

    await game.done;
    assert.equal(readFileSync(sid, "utf8"), String(game.pid));

    rmSync(sid, { force: true });
});
