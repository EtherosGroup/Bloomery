/**
 * CLI 编排：parse 层的失败也出信封
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ENTRY = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Outcome {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

// stdout 走 fd 直写，进程内截不到，只能起子进程
// 家目录指到临时目录，避免测试碰真实配置
function cli(argv: readonly string[]): Outcome {
    const home = mkdtempSync(join(tmpdir(), "bloomery-run-"));
    try {
        const result = spawnSync(process.execPath, [ENTRY, ...argv], {
            cwd: ROOT,
            encoding: "utf8",
            env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                XDG_CONFIG_HOME: join(home, ".config"),
            },
        });
        return {
            status: result.status,
            stdout: result.stdout,
            stderr: result.stderr,
        };
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
}

test("parse 层的失败在 --json 时给信封，退出码仍是 2", () => {
    const outcome = cli(["--json", "--definitely-not-an-option"]);
    assert.equal(outcome.status, 2);

    const envelope = JSON.parse(outcome.stdout) as {
        v: number;
        error: {
            code: string;
            message: string;
            detail: string;
            exit: number;
            retryable: boolean;
            context: Record<string, unknown>;
        };
    };
    assert.equal(envelope.v, 1);
    assert.equal(envelope.error.code, "UsageError");
    assert.equal(envelope.error.message, "参数不合法");
    assert.equal(envelope.error.detail, "未知选项 --definitely-not-an-option");
    assert.equal(envelope.error.exit, 2);
    assert.equal(envelope.error.retryable, false);
    assert.deepEqual(envelope.error.context, {});
    // 人类可读的那行仍在 stderr
    assert.match(outcome.stderr, /错误：参数不合法：未知选项 --definitely-not-an-option/);
});

test("选项缺取值在 --json 时给信封", () => {
    const outcome = cli(["--json", "auth", "login", "--client-id"]);
    assert.equal(outcome.status, 2);

    const envelope = JSON.parse(outcome.stdout) as { error: { code: string; exit: number } };
    assert.equal(envelope.error.code, "UsageError");
    assert.equal(envelope.error.exit, 2);
});

test("命令名之后的 --json 也算要 JSON，信封里说明位置写错", () => {
    const outcome = cli(["auth", "login", "--json"]);
    assert.equal(outcome.status, 2);

    const envelope = JSON.parse(outcome.stdout) as { error: { detail: string } };
    assert.equal(envelope.error.detail, "全局选项 --json 要写在命令名之前");
});

test("parse 层失败在非 --json 时 stdout 为空", () => {
    const outcome = cli(["--definitely-not-an-option"]);
    assert.equal(outcome.status, 2);
    assert.equal(outcome.stdout, "");
    assert.match(outcome.stderr, /错误：参数不合法：未知选项 --definitely-not-an-option/);
});

test("字符串选项的取值写成 --json 时不当成旗标", () => {
    const outcome = cli(["--home", "--json", "no-such-command"]);
    assert.equal(outcome.status, 2);
    assert.equal(outcome.stdout, "");
});
