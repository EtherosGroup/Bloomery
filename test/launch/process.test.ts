/**
 * 游戏进程：退出码带回与启动失败
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
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
