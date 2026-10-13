/**
 * 版本移除与找回：目录挪进挪出，文件一个不删
 * @author IsCibocaz
 * @since 1.14.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AppError } from "../../src/error/index.ts";
import {
    listRemoved,
    removeVersion,
    restoreVersion,
    versionNameOf,
} from "../../src/version/index.ts";

async function withVersion(body: (root: string) => Promise<void>): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "bloomery-remove-"));
    const directory = join(root, "versions", "1.20.6");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "1.20.6.json"), JSON.stringify({ id: "1.20.6" }));
    await writeFile(join(directory, "1.20.6.jar"), "jar");
    try {
        await body(root);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
}

function codeOf(error: unknown): string {
    assert.ok(error instanceof AppError, "应当是 AppError");
    return error.code;
}

test("移除把目录挪到 .removed/ 下，文件还在", async () => {
    await withVersion(async (root) => {
        const report = await removeVersion({ folderPath: root, id: "1.20.6" });

        assert.equal(report.moved, true);
        assert.equal(report.directory, join(root, ".removed", "1.20.6"));
        assert.equal(await exists(join(root, "versions", "1.20.6")), false);
        // 内容原样：json 与 jar 都在
        assert.equal(await exists(join(root, ".removed", "1.20.6", "1.20.6.json")), true);
        assert.equal(await exists(join(root, ".removed", "1.20.6", "1.20.6.jar")), true);

        assert.deepEqual(await listRemoved(root), [
            { id: "1.20.6", directory: join(root, ".removed", "1.20.6") },
        ]);
    });
});

test("找回把目录挪回 versions/", async () => {
    await withVersion(async (root) => {
        await removeVersion({ folderPath: root, id: "1.20.6" });
        const report = await restoreVersion({ folderPath: root, id: "1.20.6" });

        assert.equal(report.moved, true);
        assert.equal(report.directory, join(root, "versions", "1.20.6"));
        assert.equal(await exists(join(root, "versions", "1.20.6", "1.20.6.jar")), true);
        assert.deepEqual(await listRemoved(root), []);
    });
});

test("dry-run 只报不动", async () => {
    await withVersion(async (root) => {
        const report = await removeVersion({ folderPath: root, id: "1.20.6", dryRun: true });

        assert.equal(report.moved, false);
        assert.equal(await exists(join(root, "versions", "1.20.6")), true);
        assert.deepEqual(await listRemoved(root), []);
    });
});

test("没有这个版本、或落点已被占用都当场报错", async () => {
    await withVersion(async (root) => {
        await assert.rejects(
            removeVersion({ folderPath: root, id: "没有这个" }),
            (error: unknown) => codeOf(error) === "VersionNotFound",
        );

        // 移除过一次再移除同名：versions/ 下已经没有了
        await removeVersion({ folderPath: root, id: "1.20.6" });
        await assert.rejects(
            removeVersion({ folderPath: root, id: "1.20.6" }),
            (error: unknown) => codeOf(error) === "VersionNotFound",
        );

        // 找回时 versions/ 下又出现同名目录：不覆盖它
        await mkdir(join(root, "versions", "1.20.6"), { recursive: true });
        await assert.rejects(
            restoreVersion({ folderPath: root, id: "1.20.6" }),
            (error: unknown) => codeOf(error) === "VersionExists",
        );
    });
});

test("没有 .removed/ 时列表是空的，不报错", async () => {
    await withVersion(async (root) => {
        assert.deepEqual(await listRemoved(root), []);
    });
});

test("实例名里带点号也能移除", async () => {
    await withVersion(async (root) => {
        const name = versionNameOf("1.20.1-农夫");
        const directory = join(root, "versions", name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, `${name}.json`), JSON.stringify({ id: name }));

        const report = await removeVersion({ folderPath: root, id: name });
        assert.equal(report.directory, join(root, ".removed", name));
        assert.deepEqual(
            (await listRemoved(root)).map((item) => item.id),
            [name],
        );
    });
});

async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

test("报错时的 folder 用调用方给的 id，不给才用路径", async () => {
    await withVersion(async (root) => {
        await assert.rejects(
            restoreVersion({ folderPath: root, id: "没有这个", folderId: "g" }),
            (error: unknown) => {
                assert.equal(codeOf(error), "VersionNotFound");
                assert.equal((error as AppError).context["folder"], "g", "应当带上文件夹 id");
                return true;
            },
        );
        await assert.rejects(
            removeVersion({ folderPath: root, id: "没有这个" }),
            (error: unknown) => {
                assert.equal((error as AppError).context["folder"], root);
                return true;
            },
        );
    });
});
