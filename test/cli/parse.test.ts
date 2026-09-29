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
