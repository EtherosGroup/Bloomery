/**
 * CLI 编排：parse 层的失败也出信封，对象输出带 v
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { serve } from "../helpers/server.ts";

const ENTRY = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));

interface Outcome {
    readonly status: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

// 家目录指到临时目录，避免测试碰真实配置
function isolatedHome(extra: Readonly<Record<string, string>>): {
    home: string;
    env: NodeJS.ProcessEnv;
} {
    const home = mkdtempSync(join(tmpdir(), "bloomery-run-"));
    return {
        home,
        env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: join(home, ".config"),
            ...extra,
        },
    };
}

// stdout 走 fd 直写，进程内截不到，只能起子进程
function cli(argv: readonly string[], extra: Readonly<Record<string, string>> = {}): Outcome {
    const { home, env } = isolatedHome(extra);
    try {
        const result = spawnSync(process.execPath, [ENTRY, ...argv], {
            cwd: ROOT,
            encoding: "utf8",
            env,
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

// spawnSync 会挡住测试进程的事件循环，本地服务应答不了，这类用例走异步
function cliAsync(
    argv: readonly string[],
    extra: Readonly<Record<string, string>> = {},
): Promise<Outcome> {
    const { home, env } = isolatedHome(extra);
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY, ...argv], { cwd: ROOT, env });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (status) => {
            rmSync(home, { recursive: true, force: true });
            resolve({ status, stdout, stderr });
        });
    });
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

test("--version --json 是对象输出，带 v", () => {
    const outcome = cli(["--version", "--json"]);
    assert.equal(outcome.status, 0);

    const info = JSON.parse(outcome.stdout) as { v: number; version: string };
    assert.equal(info.v, 1);
    assert.match(info.version, /^\d+\.\d+\.\d+/);
});

test("--home 之后日志落在该目录", () => {
    const home = mkdtempSync(join(tmpdir(), "bloomery-home-"));
    try {
        const outcome = cli(["--home", home, "--json", "folder", "list"]);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.doesNotMatch(outcome.stderr, /落点写入失败/);

        const log = readFileSync(join(home, ".config", "bloomery", "logs", "latest.log"), "utf8");
        assert.match(log, /\[cli\] 命令/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("落点写不下去时 stderr 只有一行，不带栈", () => {
    // logs 处放一个普通文件，建目录必然失败；比 chmod 稳，root 也挡得住
    const home = mkdtempSync(join(tmpdir(), "bloomery-sink-"));
    mkdirSync(join(home, ".config", "bloomery"), { recursive: true });
    writeFileSync(join(home, ".config", "bloomery", "logs"), "");
    try {
        const outcome = cli(["--home", home, "--json", "folder", "list"]);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.deepEqual(JSON.parse(outcome.stdout), []);

        const lines = outcome.stderr.split("\n").filter((line) => line !== "");
        assert.equal(lines.length, 1, outcome.stderr);
        // 一行里留住原因与落点路径
        assert.match(lines[0] ?? "", /落点写入失败/);
        assert.match(lines[0] ?? "", /logs'/);
        assert.doesNotMatch(outcome.stderr, /^\s+at /m);
        assert.doesNotMatch(outcome.stderr, /errno/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

// /dev/full 写到饱都失败，write 类错误的消息里不带路径
test("写满磁盘时失败原因里带落点路径", { skip: !existsSync("/dev/full") }, () => {
    const home = mkdtempSync(join(tmpdir(), "bloomery-full-"));
    const logs = join(home, ".config", "bloomery", "logs");
    mkdirSync(logs, { recursive: true });
    symlinkSync("/dev/full", join(logs, "latest.log"));
    try {
        const outcome = cli(["--home", home, "--json", "folder", "list"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const lines = outcome.stderr.split("\n").filter((line) => line !== "");
        assert.equal(lines.length, 1, outcome.stderr);
        assert.match(lines[0] ?? "", /落点写入失败 ENOSPC/);
        assert.match(lines[0] ?? "", /latest\.log$/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("mirror update --json 是对象输出，带 v", async () => {
    const server = await serve(() => ({
        status: 200,
        body: JSON.stringify({
            entries: [{ name: "testmirror", base: "https://mirror.example.com" }],
        }),
    }));
    try {
        // 本地服务直连，不受本机代理环境影响
        const outcome = await cliAsync(
            ["--json", "mirror", "update", "--from", `${server.url}/mirrors.json`],
            { NO_PROXY: "*" },
        );
        assert.equal(outcome.status, 0, outcome.stderr);

        const file = JSON.parse(outcome.stdout) as {
            v: number;
            from: string;
            fetchedAt: string;
            entries: unknown[];
        };
        assert.equal(file.v, 1);
        assert.equal(file.from, `${server.url}/mirrors.json`);
        assert.equal(file.entries.length, 1);
    } finally {
        await server.close();
    }
});
