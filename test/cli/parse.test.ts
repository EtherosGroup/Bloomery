/**
 * CLI 解析：版本旗标与帮助的优先级
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { parse } from "../../src/cli/parse.ts";
import { CLI_SPEC } from "../../src/cli/spec.ts";
import { AppError } from "../../src/error/index.ts";

// 用法错误统一走 AppError，把 detail 取出来比消息串稳
function usageDetail(argv: readonly string[]): string {
    try {
        parse(argv, CLI_SPEC);
    } catch (error) {
        assert.ok(error instanceof AppError, `${argv.join(" ")} 应当是 AppError`);
        return String(error.context["detail"]);
    }
    return assert.fail(`应当报用法错误：${argv.join(" ")}`);
}

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

test("mod install 收多个目标", () => {
    const parsed = parse(["mod", "install", "sodium", "lithium", "ferritecore"], CLI_SPEC);
    if (parsed.kind !== "command" || parsed.command.name !== "mod") {
        assert.fail("应该是 mod 命令");
    }
    assert.equal(parsed.command.action, "install");
    assert.deepEqual(parsed.command.targets, ["sodium", "lithium", "ferritecore"]);
    assert.equal(parsed.command.query, undefined);
});

test("mod search 只收一个词，多了报错", () => {
    const parsed = parse(["mod", "search", "sodium"], CLI_SPEC);
    if (parsed.kind !== "command" || parsed.command.name !== "mod") {
        assert.fail("应该是 mod 命令");
    }
    assert.equal(parsed.command.query, "sodium");
    assert.equal(parsed.command.targets, undefined);
    assert.match(usageDetail(["mod", "search", "sodium", "lithium"]), /多余的参数/);
});

test("mod list 不需要目标，remove 至少要一个", () => {
    const parsed = parse(["mod", "list", "--offline"], CLI_SPEC);
    if (parsed.kind !== "command" || parsed.command.name !== "mod") {
        assert.fail("应该是 mod 命令");
    }
    assert.equal(parsed.command.action, "list");
    assert.deepEqual(parsed.command.targets, []);
    assert.equal(parsed.command.offline, true);
    assert.match(usageDetail(["mod", "remove"]), /至少要给一个目标/);
});

test("mod search 的 --game 与 --loader 落位", () => {
    const parsed = parse(
        ["mod", "search", "sodium", "--game", "1.20.1", "--loader", "fabric"],
        CLI_SPEC,
    );
    if (parsed.kind !== "command" || parsed.command.name !== "mod") {
        assert.fail("应该是 mod 命令");
    }
    assert.equal(parsed.command.gameVersion, "1.20.1");
    assert.equal(parsed.command.loader, "fabric");
});

test("mod 的三个管理动作各收一堆目标", () => {
    for (const action of ["remove", "disable", "enable"] as const) {
        const parsed = parse(["mod", action, "a.jar", "b.jar"], CLI_SPEC);
        if (parsed.kind !== "command" || parsed.command.name !== "mod") {
            assert.fail("应该是 mod 命令");
        }
        assert.equal(parsed.command.action, action);
        assert.deepEqual(parsed.command.targets, ["a.jar", "b.jar"]);
    }
});

test("未知的 mod 动作报用法错误", () => {
    assert.match(usageDetail(["mod", "update", "sodium"]), /action/);
});
