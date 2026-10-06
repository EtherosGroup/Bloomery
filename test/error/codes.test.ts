/**
 * 错误码表：文案、退出码与可重试标记
 * @author IsCibocaz
 * @since 1.12.4
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AppError } from "../../src/error/error.ts";
import { errorJson, errorMessage } from "../../src/error/handler.ts";
import type { ErrorCode } from "../../src/error/codes.ts";

function envelope(code: ErrorCode): {
    code: string;
    message: string;
    exit: number;
    retryable: boolean;
} {
    const json = errorJson(new AppError("test", code)) as {
        error: { code: string; message: string; exit: number; retryable: boolean };
    };
    return json.error;
}

test("加载器安装失败：exit 1、不可重试", () => {
    const error = envelope("LoaderInstallFailed");
    assert.equal(error.code, "LoaderInstallFailed");
    assert.equal(error.message, "加载器安装失败");
    assert.equal(error.exit, 1);
    // 安装器退出码非 0 重试往往没用，与下载失败区分开
    assert.equal(error.retryable, false);
});

test("可重试的只有下载失败与依赖缺失", () => {
    for (const code of ["DependencyMissing", "DownloadFailed"] as const) {
        assert.equal(envelope(code).retryable, true, code);
    }
    for (const code of [
        "LoaderInstallFailed",
        "InstallBroken",
        "GameFilesMissing",
        "FileWriteFailed",
        "JavaNotFound",
    ] as const) {
        assert.equal(envelope(code).retryable, false, code);
    }
});

test("每个码都有中文文案，且退出码在 0 到 3 之间", () => {
    for (const code of [
        "LoaderInstallFailed",
        "UsageError",
        "NotImplemented",
        "LaunchFailed",
    ] as const) {
        assert.notEqual(errorMessage(code), undefined);
        const exit = envelope(code).exit;
        assert.ok(exit >= 0 && exit <= 3, `${code} 的退出码 ${exit}`);
    }
});
