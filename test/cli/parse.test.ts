/**
 * CLI 解析：版本旗标与帮助的优先级
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parse } from "../../src/cli/parse.ts";
import { CLI_SPEC } from "../../src/cli/spec.ts";

test("--version 与 -V 都是看版本", () => {
    for (const argv of [["--version"], ["-V"], ["--version", "launch"]]) {
        assert.equal(parse(argv, CLI_SPEC).kind, "version", argv.join(" "));
    }
});

test("--help 压过 --version", () => {
    assert.equal(parse(["--help", "--version"], CLI_SPEC).kind, "help");
    assert.equal(parse(["--version", "--help"], CLI_SPEC).kind, "help");
});

test("--version 认 --json", () => {
    const parsed = parse(["--json", "--version"], CLI_SPEC);
    assert.equal(parsed.kind, "version");
    assert.equal(parsed.globals.json, true);
});

test("没给命令也没给旗标就是帮助", () => {
    assert.equal(parse([], CLI_SPEC).kind, "help");
});

test("launch 的 --repair 与 --dry-run 各自落位", () => {
    const parsed = parse(["launch", "26.2", "--repair", "--dry-run"], CLI_SPEC);
    assert.equal(parsed.kind, "command");
    if (parsed.kind !== "command" || parsed.command.name !== "launch") {
        assert.fail("应该是 launch 命令");
    }
    assert.equal(parsed.command.version, "26.2");
    assert.equal(parsed.command.repair, true);
    assert.equal(parsed.command.dryRun, true);
});
