/**
 * mod list 的中文名缓存：names 块进 JSON，offline 不推帧
 * @author IsCibocaz
 * @since 1.15.0
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// 家目录指到临时目录，避免碰真实配置
function cliAt(home: string, argv: readonly string[]): Outcome {
    const result = spawnSync(process.execPath, [ENTRY, "--home", home, ...argv], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// 一个实例、一个 jar、一份中文名表，全程不需要网络
function namesHome(): { home: string; namesPath: string } {
    const home = mkdtempSync(join(tmpdir(), "bloomery-mod-names-"));
    const config = join(home, ".config", "bloomery");
    const versions = join(home, "game", "versions");
    const instance = join(versions, "base");
    mkdirSync(join(instance, "mods"), { recursive: true });
    writeFileSync(
        join(instance, "base.json"),
        JSON.stringify({ id: "base", mainClass: "x.Y", type: "release" }),
    );
    writeFileSync(join(instance, "mods", "sodium.jar"), "jar");

    const namesPath = join(config, "metadata", "cn-names.tsv");
    mkdirSync(join(config, "metadata"), { recursive: true });
    writeFileSync(namesPath, "sodium\t钠\n");

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
                            id: "base",
                            target: "base",
                            loader: { type: "vanilla", version: null },
                            jvmArgs: [],
                            gameArgs: [],
                        },
                    ],
                },
            ],
            selectedFolder: "g",
            selectedInstance: "base",
        }),
    );
    return { home, namesPath };
}

test("mod list --json 带 names 块，cache 路径与条数来自本地表", () => {
    const { home, namesPath } = namesHome();
    try {
        const outcome = cliAt(home, ["--json", "mod", "list", "--offline"]);
        assert.equal(outcome.status, 0, outcome.stderr);
        const result = JSON.parse(outcome.stdout) as {
            names: { path: string; updatedAt: string | null; source: string; count: number };
            files: Array<{ filename: string; project: unknown; version: unknown }>;
        };
        assert.equal(result.names.path, namesPath);
        assert.equal(result.names.count, 1);
        assert.equal(result.names.updatedAt, null);
        assert.match(result.names.source, /cn-names\.tsv$/);
        assert.equal(result.files[0]?.filename, "sodium.jar");
        assert.equal(result.files[0]?.project, null);
        assert.equal(result.files[0]?.version, null);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test("mod list --offline 不推 mod-item 帧，--refresh-names 照样可解析", () => {
    const { home } = namesHome();
    try {
        const outcome = cliAt(home, [
            "--json",
            "--progress",
            "ndjson",
            "mod",
            "list",
            "--offline",
            "--refresh-names",
        ]);
        assert.equal(outcome.status, 0, outcome.stderr);
        assert.equal(outcome.stderr.includes("mod-item"), false);
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});
