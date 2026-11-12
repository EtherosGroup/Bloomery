/**
 * HMCL 数据目录：自动探测与相对路径基准
 * @author IsCibocaz
 * @since 1.16.0
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { defaultAccounts, defaultSetting } from "../../src/config/defaults.ts";
import { detectHmclHomes, planHmclImport } from "../../src/importer/index.ts";

/** 造一个便携安装：<root>/launcher/.hmcl，游戏目录与它同级 */
async function makeLocalHome(root: string): Promise<string> {
    const launcher = join(root, "launcher");
    const home = join(launcher, ".hmcl");
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "launcher-settings.json"), "{}");
    await writeFile(
        join(home, "config", "game-directories.json"),
        JSON.stringify({
            directories: [{ id: "minecraft-1", path: ".minecraft", name: "Minecraft" }],
        }),
    );
    await mkdir(join(launcher, ".minecraft", "versions", "1.20.1"), { recursive: true });
    await writeFile(join(launcher, ".minecraft", "versions", "1.20.1", "1.20.1.json"), "{}");
    return home;
}

/** 造一份用户数据：<root>/home/.hmcl，只有 user-* 那几个文件 */
async function makeUserHome(root: string): Promise<string> {
    const home = join(root, "home", ".hmcl");
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "user-settings.json"), "{}");
    return home;
}

test("detectHmclHomes：便携安装算出父目录当基准", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    try {
        const home = await makeLocalHome(root);
        const candidates = await detectHmclHomes({ roots: [home] });
        assert.equal(candidates.length, 1);
        const [candidate] = candidates;
        assert.ok(candidate !== undefined);
        assert.equal(candidate.path, home);
        assert.equal(candidate.kind, "local");
        assert.equal(candidate.base, dirname(home));
        assert.equal(candidate.folders, 1);
        assert.equal(candidate.accounts, 0);
        assert.equal(typeof candidate.modified, "number");
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("detectHmclHomes：用户数据的基准是它所在的上一层", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    try {
        const home = await makeUserHome(root);
        const candidates = await detectHmclHomes({ roots: [home] });
        assert.deepEqual(
            candidates.map((item) => [item.kind, item.path]),
            [["user", home]],
        );
        // 用户数据的相对路径按 %APPDATA%（Windows）/ Application Support（macOS）这一层展开
        assert.equal(candidates[0]?.base, dirname(home));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("detectHmclHomes：两处都认，重复的根只留一个，空目录不算", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    try {
        const local = await makeLocalHome(root);
        const user = await makeUserHome(root);
        const empty = join(root, "empty", ".hmcl");
        await mkdir(empty, { recursive: true });
        const candidates = await detectHmclHomes({
            // 同一个目录用两种写法给两遍
            roots: [local, user, empty, join(dirname(local), ".", ".hmcl")],
        });
        assert.deepEqual(candidates.map((item) => item.path).sort(), [local, user].sort());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("detectHmclHomes：没有 HMCL 数据给空表", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    try {
        assert.deepEqual(await detectHmclHomes({ roots: [join(root, ".hmcl")] }), []);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("planHmclImport：省略 base 时便携安装的相对路径按它的工作目录展开", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    try {
        const home = await makeLocalHome(root);
        const plan = await planHmclImport({
            path: home,
            setting: defaultSetting(),
            accounts: defaultAccounts(),
        });
        assert.equal(plan.base, dirname(home));
        assert.equal(plan.localHome, home);
        assert.equal(plan.userHome, null);
        assert.equal(plan.folders.added.length, 1);
        assert.equal(plan.folders.added[0]?.path, join(dirname(home), ".minecraft"));
        assert.equal(plan.folders.added[0]?.versionCount, 1);
        assert.equal(plan.folders.skipped.length, 0);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

/** 造一份不是 .hmcl 命名的用户数据：<root>/home/.local/share/hmcl，local home 在它下面的 local-stable */
async function makeSharedUserHome(root: string): Promise<{ home: string; userHome: string }> {
    const userHome = join(root, "home");
    const home = join(userHome, ".local", "share", "hmcl");
    await mkdir(join(home, "config"), { recursive: true });
    await writeFile(join(home, "config", "user-settings.json"), "{}");
    const local = join(home, "local-stable");
    await mkdir(join(local, "config"), { recursive: true });
    await writeFile(
        join(local, "config", "game-directories.json"),
        JSON.stringify({
            directories: [{ id: "minecraft-1", path: ".minecraft", name: "Minecraft" }],
        }),
    );
    return { home, userHome };
}

/** 临时把家目录指到 path，返回恢复函数（Windows 认 USERPROFILE，其它平台认 HOME） */
function useHome(path: string): () => void {
    const keys = ["HOME", "USERPROFILE"];
    const saved = keys.map((key) => [key, process.env[key]] as const);
    for (const key of keys) {
        process.env[key] = path;
    }
    return () => {
        for (const [key, value] of saved) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    };
}

test("detectHmclHomes：目录不叫 .hmcl 时基准回退家目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    const restore = useHome(join(root, "home"));
    try {
        const { home, userHome } = await makeSharedUserHome(root);
        const candidates = await detectHmclHomes({ roots: [home] });
        assert.deepEqual(
            candidates.map((item) => [item.kind, item.path]),
            [["user", home]],
        );
        // 推不出 HMCL 的工作目录，按家目录展开
        assert.equal(candidates[0]?.base, userHome);
    } finally {
        restore();
        await rm(root, { recursive: true, force: true });
    }
});

test("planHmclImport：local home 不叫 .hmcl 时基准回退家目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "bloomery-hmcl-"));
    const restore = useHome(join(root, "home"));
    try {
        const { home, userHome } = await makeSharedUserHome(root);
        const plan = await planHmclImport({
            path: home,
            setting: defaultSetting(),
            accounts: defaultAccounts(),
        });
        assert.equal(plan.localHome, join(home, "local-stable"));
        assert.equal(plan.userHome, home);
        assert.equal(plan.base, userHome);
        // 相对路径按家目录展开，而不是 local home 的上一层
        assert.deepEqual(
            plan.folders.skipped.map((item) => [item.path, item.reason]),
            [[join(userHome, ".minecraft"), "not-found"]],
        );
    } finally {
        restore();
        await rm(root, { recursive: true, force: true });
    }
});
