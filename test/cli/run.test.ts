/**
 * CLI 编排：parse 层的失败也出信封，对象输出带 v
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
    chmodSync,
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

// HOME / USERPROFILE / XDG_CONFIG_HOME 都指到同一个家目录
function environment(
    home: string,
    extra: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
    return {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        ...extra,
    };
}

// 家目录指到临时目录，避免测试碰真实配置
function isolatedHome(extra: Readonly<Record<string, string>>): {
    home: string;
    env: NodeJS.ProcessEnv;
} {
    const home = mkdtempSync(join(tmpdir(), "bloomery-run-"));
    return { home, env: environment(home, extra) };
}

// 家目录复用调用方准备好的那个：里面已经放了 accounts.json 之类
function cliAt(home: string, argv: readonly string[]): Outcome {
    const result = spawnSync(process.execPath, [ENTRY, ...argv], {
        cwd: ROOT,
        encoding: "utf8",
        env: environment(home),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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

test("--version --json 是对象输出，带 v 与 api", () => {
    const outcome = cli(["--version", "--json"]);
    assert.equal(outcome.status, 0);

    const info = JSON.parse(outcome.stdout) as { v: number; version: string; api: number };
    assert.equal(info.v, 1);
    assert.match(info.version, /^\d+\.\d+\.\d+/);
    // 外壳按 api 判兼容，不按语义版本号
    assert.equal(info.api, 1);
});

test("launch 的 --wait-for-exit 与 --detach 互斥", () => {
    const outcome = cli(["--json", "launch", "--wait-for-exit", "--detach"]);
    assert.equal(outcome.status, 2);

    const result = JSON.parse(outcome.stdout) as { error: { code: string; detail: string } };
    assert.equal(result.error.code, "UsageError");
    assert.match(result.error.detail, /--wait-for-exit/);
});

test("launch 的 --detach 可以单独给", () => {
    const outcome = cli(["--json", "launch", "--detach"]);
    // 没有配置文件夹，走到 FolderNotFound 说明选项本身解析通过
    assert.equal(outcome.status, 1);
    const result = JSON.parse(outcome.stdout) as { error: { code: string } };
    assert.equal(result.error.code, "FolderNotFound");
});

// 起一次真进程：/json 的 pid 是 detach 之后认这个实例的唯一判据
// instances 可带点号：配置键的点分寻址对这类 id 不成立，走 --folder / --instance
function writableLaunchHome(instances: readonly string[] = ["test6"]): string {
    const home = mkdtempSync(join(tmpdir(), "bloomery-launch-"));
    const config = join(home, ".config", "bloomery");
    const game = join(home, "game");
    const java = join(home, "fake-java");
    mkdirSync(config, { recursive: true });

    // 冒充 java：探测时答主版本，被启动时往两路各写一行
    writeFileSync(
        java,
        `#!/bin/sh
case "$*" in
    *-XshowSettings:properties*)
        printf '    java.version = 21.0.1\\n    os.arch = amd64\\n    java.vendor = Fake\\n'
        ;;
    *)
        printf 'GAME-OUT\\n'
        printf 'GAME-ERR\\n' >&2
        ;;
esac
exit 0
`,
        { mode: 0o755 },
    );
    for (const id of instances) {
        mkdirSync(join(game, "versions", id), { recursive: true });
        writeFileSync(
            join(game, "versions", id, `${id}.json`),
            JSON.stringify({
                id: "1.20.6",
                mainClass: "x.Y",
                type: "release",
                javaVersion: { majorVersion: 21 },
            }),
        );
        writeFileSync(join(game, "versions", id, `${id}.jar`), "");
    }
    writeFileSync(
        join(config, "setting.json"),
        JSON.stringify({
            schemaVersion: 1,
            folders: [
                {
                    id: "g",
                    path: game,
                    autoDiscover: true,
                    missingEntries: "keep",
                    instances: [],
                },
            ],
            java: {
                autoDetect: false,
                autoDownload: false,
                runtimeDirectory: null,
                list: [
                    {
                        path: java,
                        major: 21,
                        kind: "jre",
                        arch: "x64",
                        vendor: "Fake",
                        source: "manual",
                    },
                ],
            },
            selectedFolder: "g",
            selectedInstance: "test6",
        }),
    );
    writeFileSync(
        join(config, "accounts.json"),
        JSON.stringify({
            schemaVersion: 1,
            accounts: [{ id: "Steve@offline", type: "offline", name: "Steve", uuid: null }],
        }),
    );
    return home;
}

// 游戏进程与 CLI 同时收尾，落盘可能慢半拍
async function logText(path: string): Promise<string> {
    for (let attempt = 0; attempt < 50; attempt++) {
        try {
            const text = readFileSync(path, "utf8");
            if (text.includes("GAME-OUT")) {
                return text;
            }
        } catch {
            // 还没建出来
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return readFileSync(path, "utf8");
}

test(
    "launch --detach 的 JSON 带 pid，游戏输出进日志文件",
    { skip: process.platform === "win32" },
    async () => {
        const home = writableLaunchHome();
        try {
            const outcome = cliAt(home, ["--json", "launch", "test6", "--detach"]);
            assert.equal(outcome.status, 0, outcome.stderr);

            // stdout 整份是 JSON：游戏的两路输出都不许混进来
            const result = JSON.parse(outcome.stdout) as {
                pid: number | null;
                log: string | null;
                version: string;
            };
            assert.equal(typeof result.pid, "number");
            assert.ok((result.pid ?? 0) > 0);
            assert.equal(result.version, "test6");
            assert.ok(result.log !== null && result.log.endsWith("instance-test6.log"));

            const text = await logText(result.log);
            assert.match(text, /GAME-OUT/);
            assert.match(text, /GAME-ERR/);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    },
);

test("launch --dry-run 的 pid 与 log 都是 null", { skip: process.platform === "win32" }, () => {
    const home = writableLaunchHome();
    try {
        const outcome = cliAt(home, ["--json", "launch", "test6", "--dry-run"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as { pid: number | null; log: string | null };
        assert.equal(result.pid, null);
        assert.equal(result.log, null);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("--json 下等游戏退出，stdout 仍只有一份 JSON", { skip: process.platform === "win32" }, () => {
    const home = writableLaunchHome();
    try {
        const outcome = cliAt(home, ["--json", "launch", "test6", "--wait-for-exit"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as { pid: number | null; log: string | null };
        assert.equal(typeof result.pid, "number");
        assert.ok(result.log !== null);
        assert.doesNotMatch(outcome.stdout, /GAME-OUT/);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("launch --memory 压过配置里的内存上限", { skip: process.platform === "win32" }, () => {
    const home = writableLaunchHome();
    try {
        const outcome = cliAt(home, ["--json", "launch", "test6", "--dry-run", "--memory", "2048"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as { args: string[] };
        assert.ok(result.args.includes("-Xmx2048M"), result.args.join(" "));
        assert.ok(!result.args.includes("-Xmx4096M"), result.args.join(" "));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("launch --memory 不合法时报用法错误", { skip: process.platform === "win32" }, () => {
    const home = writableLaunchHome();
    try {
        // 默认下限 512MB
        const low = cliAt(home, ["--json", "launch", "test6", "--dry-run", "--memory", "256"]);
        assert.equal(low.status, 2);
        assert.equal(
            (JSON.parse(low.stdout) as { error: { code: string } }).error.code,
            "UsageError",
        );

        const bad = cliAt(home, ["--json", "launch", "test6", "--dry-run", "--memory", "abc"]);
        assert.equal(bad.status, 2);
        assert.equal(
            (JSON.parse(bad.stdout) as { error: { code: string } }).error.code,
            "UsageError",
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("config 读写全局键，unset 回默认", () => {
    const home = writableLaunchHome();
    try {
        const before = cliAt(home, ["--json", "config", "get", "network.concurrency"]);
        assert.equal(before.status, 0, before.stderr);
        assert.equal((JSON.parse(before.stdout) as { value: number }).value, 8);

        const set = cliAt(home, ["--json", "config", "set", "network.concurrency", "16"]);
        assert.equal(set.status, 0, set.stderr);
        assert.equal((JSON.parse(set.stdout) as { value: number }).value, 16);

        const read = cliAt(home, ["--json", "config", "get", "network.concurrency"]);
        assert.equal((JSON.parse(read.stdout) as { value: number }).value, 16);

        const unset = cliAt(home, ["--json", "config", "unset", "network.concurrency"]);
        assert.equal(unset.status, 0, unset.stderr);
        assert.equal((JSON.parse(unset.stdout) as { value: number }).value, 8);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("config set 按 JSON 字面量认值，null 用来清空", () => {
    const home = writableLaunchHome();
    try {
        const array = cliAt(home, [
            "--json",
            "config",
            "set",
            "launch.jvmArgs",
            '["-XX:+UseG1GC"]',
        ]);
        assert.equal(array.status, 0, array.stderr);
        assert.deepEqual((JSON.parse(array.stdout) as { value: string[] }).value, ["-XX:+UseG1GC"]);

        const nul = cliAt(home, ["--json", "config", "set", "network.proxy", "null"]);
        assert.equal(nul.status, 0, nul.stderr);
        assert.equal((JSON.parse(nul.stdout) as { value: null }).value, null);

        const text = cliAt(home, [
            "--json",
            "config",
            "set",
            "network.proxy",
            "http://127.0.0.1:7890",
        ]);
        assert.equal((JSON.parse(text.stdout) as { value: string }).value, "http://127.0.0.1:7890");

        // --string 让它保持字符串
        const forced = cliAt(home, [
            "--json",
            "config",
            "set",
            "network.proxy",
            "8080",
            "--string",
        ]);
        assert.equal((JSON.parse(forced.stdout) as { value: string }).value, "8080");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("config 拒绝未知键、别的命令管的键与类型不符的值", () => {
    const home = writableLaunchHome();
    try {
        const cases: Array<[string, string]> = [
            ["config set network.concurrency2 8", "未知的配置键 network.concurrency2"],
            ["config set selectedFolder g", "selectedFolder 由 folder select 管"],
            ["config set download.verify nope", "strict / warn / off：nope"],
            ["config set network.concurrency abc", "整数：abc"],
            ["config set network.proxy 8080", "字符串或 null：8080"],
        ];
        for (const [argv, needle] of cases) {
            const outcome = cliAt(home, ["--json", ...argv.split(" ")]);
            assert.equal(outcome.status, 2, `${argv}：${outcome.stdout}`);
            const error = JSON.parse(outcome.stdout) as { error: { code: string; detail: string } };
            assert.equal(error.error.code, "UsageError");
            assert.match(
                error.error.detail,
                new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
            );
        }
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

// 实例 id 里有点号时点分寻址不成立，走 --folder / --instance
test(
    "config 用 --folder / --instance 寻址含点号的实例 id",
    { skip: process.platform === "win32" },
    () => {
        const dotted = "1.20.1-农夫";
        const home = writableLaunchHome(["test6", dotted]);
        try {
            // 旧的点分写法对这类 id 认不出来
            const broken = cliAt(home, [
                "--json",
                "config",
                "get",
                `folders.g.instances.${dotted}.memory.maxMb`,
            ]);
            assert.equal(broken.status, 2);
            assert.equal(
                (JSON.parse(broken.stdout) as { error: { code: string } }).error.code,
                "UsageError",
            );

            // flag 形式：配置里还没有这条实例，按磁盘上的版本补一条
            const set = cliAt(home, [
                "--json",
                "config",
                "set",
                "memory.maxMb",
                "3072",
                "--folder",
                "g",
                "--instance",
                dotted,
            ]);
            assert.equal(set.status, 0, set.stderr);
            const written = JSON.parse(set.stdout) as {
                key: string;
                folder: string;
                instance: string;
                value: number;
            };
            assert.equal(written.key, "memory.maxMb");
            assert.equal(written.folder, "g");
            assert.equal(written.instance, dotted);
            assert.equal(written.value, 3072);

            const read = cliAt(home, [
                "--json",
                "config",
                "get",
                "memory.maxMb",
                "--folder",
                "g",
                "--instance",
                dotted,
            ]);
            assert.equal((JSON.parse(read.stdout) as { value: number }).value, 3072);

            // 启动计划跟着变，说明补出来的实例条目被配置读进去了
            const plan = cliAt(home, ["--json", "launch", dotted, "--dry-run"]);
            assert.equal(plan.status, 0, plan.stderr);
            const args = (JSON.parse(plan.stdout) as { args: string[] }).args;
            assert.ok(args.includes("-Xmx3072M"), args.join(" "));

            // 不带键时给该实例的整条配置
            const entry = cliAt(home, [
                "--json",
                "config",
                "get",
                "--folder",
                "g",
                "--instance",
                dotted,
            ]);
            assert.equal(entry.status, 0, entry.stderr);
            const value = (JSON.parse(entry.stdout) as { value: { id: string; memory: unknown } })
                .value;
            assert.equal(value.id, dotted);
            assert.deepEqual(value.memory, { maxMb: 3072 });

            const unset = cliAt(home, [
                "--json",
                "config",
                "unset",
                "memory.maxMb",
                "--folder",
                "g",
                "--instance",
                dotted,
            ]);
            assert.equal(unset.status, 0, unset.stderr);
            assert.equal((JSON.parse(unset.stdout) as { value: null }).value, null);
        } finally {
            rmSync(home, { recursive: true, force: true });
        }
    },
);

test("config 的 --instance 要配 --folder，两种寻址不能混用", () => {
    const home = writableLaunchHome();
    try {
        const orphan = cliAt(home, ["--json", "config", "get", "memory.maxMb", "--instance", "x"]);
        assert.equal(orphan.status, 2);
        assert.match(
            (JSON.parse(orphan.stdout) as { error: { detail: string } }).error.detail,
            /--instance 要配 --folder/,
        );

        const mixed = cliAt(home, [
            "--json",
            "config",
            "get",
            "folders.g.instances.test6.memory.maxMb",
            "--folder",
            "g",
        ]);
        assert.equal(mixed.status, 2);

        // 全局键不能带作用域
        const wrongScope = cliAt(home, [
            "--json",
            "config",
            "set",
            "network.concurrency",
            "16",
            "--folder",
            "g",
        ]);
        assert.equal(wrongScope.status, 2);
        assert.match(
            (JSON.parse(wrongScope.stdout) as { error: { detail: string } }).error.detail,
            /未知的配置键 network\.concurrency（文件夹级）/,
        );

        // 文件夹不存在
        const noFolder = cliAt(home, ["--json", "config", "get", "name", "--folder", "nope"]);
        assert.equal(noFolder.status, 1);
        assert.equal(
            (JSON.parse(noFolder.stdout) as { error: { code: string } }).error.code,
            "FolderNotFound",
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("config 写实例级内存覆盖，启动计划跟着变", { skip: process.platform === "win32" }, () => {
    const home = writableLaunchHome();
    try {
        const set = cliAt(home, [
            "--json",
            "config",
            "set",
            "folders.g.instances.test6.memory.maxMb",
            "3072",
        ]);
        assert.equal(set.status, 0, set.stderr);

        const read = cliAt(home, [
            "--json",
            "config",
            "get",
            "folders.g.instances.test6.memory.maxMb",
        ]);
        assert.equal((JSON.parse(read.stdout) as { value: number }).value, 3072);

        const plan = cliAt(home, ["--json", "launch", "test6", "--dry-run"]);
        assert.equal(plan.status, 0, plan.stderr);
        const args = (JSON.parse(plan.stdout) as { args: string[] }).args;
        assert.ok(args.includes("-Xmx3072M"), args.join(" "));

        const unset = cliAt(home, [
            "--json",
            "config",
            "unset",
            "folders.g.instances.test6.memory.maxMb",
        ]);
        assert.equal(unset.status, 0, unset.stderr);
        assert.equal((JSON.parse(unset.stdout) as { value: null }).value, null);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

// 数据目录只读：让落盘失败可诊断，而不是笼统的内部错误
test(
    "配置写不下去时报 FileWriteFailed，detail 带 errno 与路径",
    { skip: process.platform === "win32" },
    () => {
        const home = writableLaunchHome();
        const config = join(home, ".config", "bloomery");
        try {
            chmodSync(config, 0o555);
            const outcome = cliAt(home, ["--json", "version", "select", "test6"]);
            assert.equal(outcome.status, 1, outcome.stderr);

            const result = JSON.parse(outcome.stdout) as {
                error: {
                    code: string;
                    message: string;
                    detail: string;
                    retryable: boolean;
                    exit: number;
                };
            };
            assert.equal(result.error.code, "FileWriteFailed");
            assert.equal(result.error.message, "文件写入失败");
            assert.equal(result.error.exit, 1);
            assert.equal(result.error.retryable, false);
            assert.match(result.error.detail, /^(EACCES|EROFS|EPERM) /);
            assert.match(result.error.detail, /setting\.json$/);
        } finally {
            chmodSync(config, 0o755);
            rmSync(home, { recursive: true, force: true });
        }
    },
);

test("status 在空数据目录下按未设置报", () => {
    const home = mkdtempSync(join(tmpdir(), "bloomery-status-"));
    try {
        const outcome = cliAt(home, ["--json", "status"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as {
            api: number;
            node: string;
            home: string;
            host: { platform: string; arch: string; memoryMb: number };
            java: unknown[];
            javaDefault: string | null;
            memory: { minMb: number; maxMb: number; globalMb: number; currentMb: number | null };
            folder: unknown;
            mirror: { source: string | null; presets: Array<{ id: string }> };
            features: string[];
        };
        assert.equal(result.api, 1);
        assert.match(result.node, /^\d+\./);
        assert.equal(result.host.memoryMb > 0, true);
        assert.equal(result.home, join(home, ".config", "bloomery"));
        assert.deepEqual(result.java, []);
        assert.equal(result.javaDefault, null);
        assert.equal(result.memory.globalMb, 4096);
        assert.equal(result.memory.currentMb, null);
        assert.equal(result.folder, null);
        // 没有 setting.json：生效值都是默认值，对外报未设置
        assert.equal(result.mirror.source, null);
        assert.ok(result.mirror.presets.some((item) => item.id === "bmclapi"));
        assert.ok(result.features.includes("progressKey"));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("status 给出选中实例与 Java 详情", { skip: process.platform === "win32" }, () => {
    const home = writableLaunchHome();
    try {
        const outcome = cliAt(home, ["--json", "status"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as {
            java: Array<{
                path: string;
                version: string | null;
                usable: boolean;
                present: boolean;
            }>;
            javaDefault: string | null;
            memory: { currentMb: number | null };
            folder: {
                id: string;
                selected: boolean;
                selectedInstance: string | null;
                instanceCount: number;
            };
            mirror: { source: string | null };
        };
        assert.equal(result.folder.selected, true);
        assert.equal(result.folder.selectedInstance, "test6");
        assert.equal(result.folder.instanceCount, 1);
        assert.equal(result.java.length, 1);
        assert.equal(result.java[0]?.version, "21.0.1");
        assert.equal(result.java[0]?.usable, true);
        assert.equal(result.java[0]?.present, true);
        assert.equal(result.javaDefault, result.java[0]?.path);
        assert.equal(result.memory.currentMb, 4096);
        assert.equal(result.mirror.source, "official");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
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

/* ---------- auth ---------- */

const OFFLINE = { id: "cibocaz@offline", type: "offline", name: "cibocaz", uuid: null };
const MICROSOFT = {
    id: "XiangYuanHuLian@microsoft",
    type: "microsoft",
    name: "XiangYuanHuLian",
    uuid: "8a466271-61ee-4edc-837f-bf80f1587ea4",
    xuid: null,
    refreshToken: "refresh",
    accessToken: "access",
    expiresAt: "2030-01-01T00:00:00.000Z",
    clientId: "client",
};
// 与上面那条微软账户同名：登出时只给名字就分不出来
const MICROSOFT_OFFLINE_TWIN = {
    id: "XiangYuanHuLian@offline",
    type: "offline",
    name: "XiangYuanHuLian",
    uuid: null,
};

// 预置 accounts.json 与 setting.json 的家目录
function authHome(accounts: readonly unknown[], selected: string | null): string {
    const home = mkdtempSync(join(tmpdir(), "bloomery-auth-"));
    const config = join(home, ".config", "bloomery");
    mkdirSync(config, { recursive: true });
    writeFileSync(
        join(config, "accounts.json"),
        JSON.stringify({ schemaVersion: 1, accounts }, null, 4),
    );
    writeFileSync(
        join(config, "setting.json"),
        JSON.stringify({ schemaVersion: 1, selectedAccount: selected, folders: [] }, null, 4),
    );
    return home;
}

function accountIds(home: string): string[] {
    const file = JSON.parse(
        readFileSync(join(home, ".config", "bloomery", "accounts.json"), "utf8"),
    ) as { accounts: { id: string }[] };
    return file.accounts.map((account) => account.id);
}

function selectedAccount(home: string): string | null {
    const file = JSON.parse(
        readFileSync(join(home, ".config", "bloomery", "setting.json"), "utf8"),
    ) as { selectedAccount: string | null };
    return file.selectedAccount;
}

test("auth login 不给 --type 时仍按离线", () => {
    const home = authHome([MICROSOFT], null);
    try {
        const outcome = cliAt(home, ["--home", home, "--json", "auth", "login", "cibocaz"]);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.deepEqual(accountIds(home), ["XiangYuanHuLian@microsoft", "cibocaz@offline"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth use 只切当前账号，不碰账户文件", () => {
    const home = authHome([OFFLINE, MICROSOFT], OFFLINE.id);
    try {
        const before = readFileSync(join(home, ".config", "bloomery", "accounts.json"), "utf8");
        const outcome = cliAt(home, ["--home", home, "--json", "auth", "use", "XiangYuanHuLian"]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as { id: string; name: string; type: string };
        assert.equal(result.id, MICROSOFT.id);
        assert.equal(result.name, "XiangYuanHuLian");
        assert.equal(result.type, "microsoft");
        assert.equal(selectedAccount(home), MICROSOFT.id);
        // 账户文件一个字节都不动
        assert.equal(
            readFileSync(join(home, ".config", "bloomery", "accounts.json"), "utf8"),
            before,
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth use 同名多条要给 --type，给了就按那条切", () => {
    const home = authHome([MICROSOFT, MICROSOFT_OFFLINE_TWIN], MICROSOFT.id);
    try {
        const ambiguous = cliAt(home, ["--home", home, "--json", "auth", "use", "XiangYuanHuLian"]);
        assert.equal(ambiguous.status, 2);
        const error = JSON.parse(ambiguous.stdout) as { error: { code: string; detail: string } };
        assert.equal(error.error.code, "UsageError");
        assert.match(error.error.detail, /microsoft \/ offline/);

        const typed = cliAt(home, [
            "--home",
            home,
            "--json",
            "auth",
            "use",
            "XiangYuanHuLian",
            "--type",
            "offline",
        ]);
        assert.equal(typed.status, 0, typed.stderr);
        assert.equal(selectedAccount(home), MICROSOFT_OFFLINE_TWIN.id);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth use 找不到时报 AccountNotFound", () => {
    const home = authHome([OFFLINE], OFFLINE.id);
    try {
        const outcome = cliAt(home, ["--home", home, "--json", "auth", "use", "Nobody"]);
        assert.equal(outcome.status, 1);
        const error = JSON.parse(outcome.stdout) as { error: { code: string; detail: string } };
        assert.equal(error.error.code, "AccountNotFound");
        assert.equal(error.error.detail, "Nobody");
        // 选中项没被动过
        assert.equal(selectedAccount(home), OFFLINE.id);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth logout 不给 --type 时按游戏名找，微软账户也删得掉", () => {
    const home = authHome([OFFLINE, MICROSOFT], MICROSOFT.id);
    try {
        const outcome = cliAt(home, [
            "--home",
            home,
            "--json",
            "auth",
            "logout",
            "XiangYuanHuLian",
        ]);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.deepEqual(JSON.parse(outcome.stdout), {
            v: 1,
            removed: "XiangYuanHuLian@microsoft",
        });
        assert.deepEqual(accountIds(home), ["cibocaz@offline"]);
        // 删掉的正是当前账户，选中要清空
        assert.equal(selectedAccount(home), null);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth logout 同名多条时报用法错误，detail 列出类型", () => {
    const home = authHome([OFFLINE, MICROSOFT, MICROSOFT_OFFLINE_TWIN], MICROSOFT.id);
    try {
        const outcome = cliAt(home, [
            "--home",
            home,
            "--json",
            "auth",
            "logout",
            "XiangYuanHuLian",
        ]);
        assert.equal(outcome.status, 2, outcome.stderr);
        const envelope = JSON.parse(outcome.stdout) as { error: { code: string; detail: string } };
        assert.equal(envelope.error.code, "UsageError");
        assert.match(envelope.error.detail, /microsoft/);
        assert.match(envelope.error.detail, /offline/);
        // 用法错误不落盘
        assert.deepEqual(accountIds(home), [
            "cibocaz@offline",
            "XiangYuanHuLian@microsoft",
            "XiangYuanHuLian@offline",
        ]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth logout 带 --type 只认那一条", () => {
    const home = authHome([OFFLINE, MICROSOFT, MICROSOFT_OFFLINE_TWIN], MICROSOFT.id);
    try {
        const outcome = cliAt(home, [
            "--home",
            home,
            "--json",
            "auth",
            "logout",
            "XiangYuanHuLian",
            "--type",
            "microsoft",
        ]);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.deepEqual(accountIds(home), ["cibocaz@offline", "XiangYuanHuLian@offline"]);
        assert.equal(selectedAccount(home), null);

        // 类型对不上时还是 AccountNotFound，不碰同名的那条
        const missing = cliAt(home, [
            "--home",
            home,
            "--json",
            "auth",
            "logout",
            "cibocaz",
            "--type",
            "microsoft",
        ]);
        assert.equal(missing.status, 1, missing.stderr);
        const envelope = JSON.parse(missing.stdout) as { error: { code: string; detail: string } };
        assert.equal(envelope.error.code, "AccountNotFound");
        assert.equal(envelope.error.detail, "cibocaz@microsoft");
        assert.deepEqual(accountIds(home), ["cibocaz@offline", "XiangYuanHuLian@offline"]);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("auth logout 找不到时按名字报 AccountNotFound", () => {
    const home = authHome([OFFLINE], null);
    try {
        const outcome = cliAt(home, ["--home", home, "--json", "auth", "logout", "没有这个人"]);
        assert.equal(outcome.status, 1, outcome.stderr);
        const envelope = JSON.parse(outcome.stdout) as { error: { code: string; detail: string } };
        assert.equal(envelope.error.code, "AccountNotFound");
        assert.equal(envelope.error.detail, "没有这个人");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

/* ---------- version rename ---------- */

// 一份基础版本 + 一份继承它的版本：改名要连继承引用一起收
function renameHome(): string {
    const home = mkdtempSync(join(tmpdir(), "bloomery-rename-"));
    const config = join(home, ".config", "bloomery");
    const versions = join(home, "game", "versions");
    mkdirSync(config, { recursive: true });
    for (const id of ["1.20.6", "base-fabric"]) {
        mkdirSync(join(versions, id), { recursive: true });
        writeFileSync(join(versions, id, `${id}.jar`), "");
    }
    writeFileSync(
        join(versions, "1.20.6", "1.20.6.json"),
        JSON.stringify({ id: "1.20.6", mainClass: "x.Y", type: "release" }),
    );
    writeFileSync(
        join(versions, "base-fabric", "base-fabric.json"),
        JSON.stringify({
            id: "fabric-loader",
            inheritsFrom: "1.20.6",
            mainClass: "x.Y",
            type: "release",
        }),
    );
    writeFileSync(
        join(config, "setting.json"),
        JSON.stringify({
            schemaVersion: 1,
            folders: [
                {
                    id: "g",
                    path: join(home, "game"),
                    autoDiscover: true,
                    missingEntries: "keep",
                    instances: [
                        {
                            id: "base-fabric",
                            target: "1.20.6",
                            loader: { type: "fabric", version: "0.19.5" },
                            jvmArgs: [],
                            gameArgs: [],
                        },
                    ],
                },
            ],
            selectedFolder: "g",
            selectedInstance: "1.20.6",
        }),
    );
    writeFileSync(
        join(config, "state.json"),
        JSON.stringify({
            schemaVersion: 1,
            lastInstance: "1.20.6",
            instances: { "g/1.20.6": { playTimeMinutes: 42, launchCount: 7 } },
            javaProbe: {},
        }),
    );
    return home;
}

function readJsonAt(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

test("version rename 改目录与 jar，并同步继承引用", () => {
    const home = renameHome();
    const versions = join(home, "game", "versions");
    try {
        const outcome = cliAt(home, [
            "--home",
            home,
            "--json",
            "version",
            "rename",
            "1.20.6",
            "vanilla",
        ]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as {
            id: string;
            from: string;
            folder: string;
            moved: boolean;
            rewritten: string[];
        };
        assert.equal(result.id, "vanilla");
        assert.equal(result.from, "1.20.6");
        assert.equal(result.folder, "g");
        assert.equal(result.moved, true);
        assert.deepEqual(result.rewritten, ["base-fabric"]);

        // 目录、json、jar 一起改名
        assert.equal(existsSync(join(versions, "1.20.6")), false);
        assert.equal(existsSync(join(versions, "vanilla", "vanilla.json")), true);
        assert.equal(existsSync(join(versions, "vanilla", "vanilla.jar")), true);

        // 继承引用改成新名字，被继承的那个实例仍然可读
        const child = readJsonAt(join(versions, "base-fabric", "base-fabric.json"));
        assert.equal(child["inheritsFrom"], "vanilla");

        const list = cliAt(home, ["--home", home, "--json", "version", "list"]);
        assert.equal(list.status, 0, list.stderr);
        const view = JSON.parse(list.stdout) as {
            instances: Array<{ id: string; state: string; chain: string[] }>;
        };
        const renamed = view.instances.find((item) => item.id === "vanilla");
        assert.equal(renamed?.state, "ready");
        assert.deepEqual(renamed?.chain, ["vanilla"]);
        assert.deepEqual(view.instances.find((item) => item.id === "base-fabric")?.chain, [
            "base-fabric",
            "vanilla",
        ]);

        // 配置：选中项与别的实例的 target 都跟着改
        const setting = readJsonAt(join(home, ".config", "bloomery", "setting.json"));
        assert.equal(setting["selectedInstance"], "vanilla");
        const instances = (
            setting["folders"] as Array<{ instances: Array<{ id: string; target: string }> }>
        )[0]?.instances;
        assert.equal(instances?.[0]?.target, "vanilla");

        // 状态：统计键与上次启动的实例也搬过去
        const state = readJsonAt(join(home, ".config", "bloomery", "state.json"));
        assert.equal(state["lastInstance"], "vanilla");
        assert.deepEqual(state["instances"], {
            "g/vanilla": { lastPlayedAt: null, playTimeMinutes: 42, launchCount: 7 },
        });
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("version rename --dry-run 不动磁盘", () => {
    const home = renameHome();
    const versions = join(home, "game", "versions");
    try {
        const outcome = cliAt(home, [
            "--home",
            home,
            "--json",
            "version",
            "rename",
            "1.20.6",
            "vanilla",
            "--dry-run",
        ]);
        assert.equal(outcome.status, 0, outcome.stderr);

        const result = JSON.parse(outcome.stdout) as { moved: boolean; rewritten: string[] };
        assert.equal(result.moved, false);
        assert.deepEqual(result.rewritten, ["base-fabric"]);
        assert.equal(existsSync(join(versions, "1.20.6")), true);
        assert.equal(existsSync(join(versions, "vanilla")), false);
        assert.equal(
            readJsonAt(join(home, ".config", "bloomery", "setting.json"))["selectedInstance"],
            "1.20.6",
        );
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("version rename 的名字与目标校验", () => {
    const home = renameHome();
    try {
        // 同名幂等
        const same = cliAt(home, [
            "--home",
            home,
            "--json",
            "version",
            "rename",
            "1.20.6",
            "1.20.6",
        ]);
        assert.equal(same.status, 0, same.stderr);
        assert.equal((JSON.parse(same.stdout) as { moved: boolean }).moved, false);

        // 已存在
        const taken = cliAt(home, [
            "--home",
            home,
            "--json",
            "version",
            "rename",
            "1.20.6",
            "base-fabric",
        ]);
        assert.equal(taken.status, 1);
        assert.equal(
            (JSON.parse(taken.stdout) as { error: { code: string } }).error.code,
            "VersionExists",
        );

        // 不存在
        const missing = cliAt(home, ["--home", home, "--json", "version", "rename", "nope", "x"]);
        assert.equal(missing.status, 1);
        assert.equal(
            (JSON.parse(missing.stdout) as { error: { code: string } }).error.code,
            "VersionNotFound",
        );

        // 名字不合法
        for (const bad of ["../x", "a/b", "a\\b", "  "]) {
            const outcome = cliAt(home, [
                "--home",
                home,
                "--json",
                "version",
                "rename",
                "1.20.6",
                bad,
            ]);
            assert.equal(outcome.status, 2, `${bad}：${outcome.stdout}`);
            assert.equal(
                (JSON.parse(outcome.stdout) as { error: { code: string } }).error.code,
                "UsageError",
            );
        }

        // 首尾空白去掉后可用
        const trimmed = cliAt(home, [
            "--home",
            home,
            "--json",
            "version",
            "rename",
            "1.20.6",
            "  vanilla  ",
        ]);
        assert.equal(trimmed.status, 0, trimmed.stderr);
        assert.equal((JSON.parse(trimmed.stdout) as { id: string }).id, "vanilla");
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
