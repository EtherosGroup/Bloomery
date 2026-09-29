/**
 * 启动规划：客户端 jar 落在哪个目录
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import { defaultSetting } from "../../src/config/index.ts";
import type { Accounts, Folder, JavaSetting } from "../../src/config/types.ts";
import { planLaunch } from "../../src/launch/game.ts";
import { findJava, javaEntryOf, probeJava } from "../../src/launch/java.ts";
import { readFolder } from "../../src/version/folder.ts";

const JAVA: JavaSetting = {
    autoDetect: true,
    autoDownload: false,
    runtimeDirectory: null,
    list: [],
};

const ACCOUNTS: Accounts = {
    schemaVersion: 1,
    accounts: [{ id: "offline:Steve", type: "offline", name: "Steve", uuid: null }],
};

const MAIN_CLASS = { mainClass: "x.Y", type: "release" };

async function writeVersion(root: string, dir: string, json: unknown, jar: boolean): Promise<void> {
    await mkdir(join(root, "versions", dir), { recursive: true });
    await writeFile(join(root, "versions", dir, `${dir}.json`), JSON.stringify(json));
    if (jar) {
        await writeFile(join(root, "versions", dir, `${dir}.jar`), "");
    }
}

test("客户端 jar 的落点：继承型用基础版本，自带的用自己的目录", async (t) => {
    const paths = await findJava(JAVA);
    const executable = paths[0];
    if (executable === undefined) {
        t.skip("本机没有 Java");
        return;
    }
    const info = await probeJava(executable, "manual");
    assert.ok(info !== null);

    const setting = { ...defaultSetting(), java: { ...JAVA, list: [javaEntryOf(info)] } };
    const root = await mkdtemp(join(tmpdir(), "bloomery-plan-"));

    try {
        // 自带 jar 的原版
        await writeVersion(root, "1.20.6", { id: "1.20.6", ...MAIN_CLASS }, true);
        // install --name 装出来的：目录名与 json 的 id 不同，jar 跟着目录
        await writeVersion(root, "test6", { id: "1.20.6", ...MAIN_CLASS }, true);
        // 继承型：自己目录里没有 jar，得用基础版本那份
        await writeVersion(
            root,
            "knot",
            { id: "knot", inheritsFrom: "1.20.6", ...MAIN_CLASS },
            false,
        );

        const folder: Folder = {
            id: "f",
            path: root,
            autoDiscover: true,
            missingEntries: "keep",
            instances: [],
        };
        const view = await readFolder(folder);
        const instances = new Map(view.instances.map((one) => [one.id, one]));

        const jarOf = async (id: string): Promise<string> => {
            const instance = instances.get(id);
            assert.ok(instance !== undefined, `${id} 应该在扫描结果里`);
            const plan = await planLaunch(
                { setting, folder, config: undefined, instance, accounts: ACCOUNTS, probes: {} },
                { prepare: false },
            );
            const classpath = plan.args[plan.args.indexOf("-cp") + 1] ?? "";
            return classpath.split(delimiter).at(-1) ?? "";
        };

        assert.equal(await jarOf("1.20.6"), join(root, "versions", "1.20.6", "1.20.6.jar"));
        assert.equal(await jarOf("test6"), join(root, "versions", "test6", "test6.jar"));
        assert.equal(await jarOf("knot"), join(root, "versions", "1.20.6", "1.20.6.jar"));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
