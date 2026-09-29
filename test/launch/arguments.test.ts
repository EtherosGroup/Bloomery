/**
 * 启动层：占位符、参数拼装、取值来源、账户、退出码
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultSetting } from "../../src/config/index.ts";
import type { Accounts, Folder, Instance, MicrosoftAccount } from "../../src/config/types.ts";
import { platformContext } from "../../src/dependency/index.ts";
import { accountFor, offlineUuid } from "../../src/launch/account.ts";
import {
    buildGameArguments,
    buildJvmArguments,
    expandArguments,
    substitute,
    type ArgumentContext,
} from "../../src/launch/arguments.ts";
import { exitCodeOf } from "../../src/launch/exit.ts";
import { launchOptionsOf } from "../../src/launch/options.ts";
import { parseDescriptor } from "../../src/version/descriptor.ts";

const RULES = platformContext({ is_demo_user: false, has_custom_resolution: true });

const CONTEXT: ArgumentContext = {
    versionName: "1.20.6",
    versionType: "Bloomery",
    gameDirectory: "/games/versions/1.20.6",
    assetsRoot: "/games/assets",
    assetIndex: "16",
    nativesDirectory: "/games/versions/1.20.6/natives",
    librariesRoot: "/games/libraries",
    classpath: "/a.jar:/b.jar",
    userName: "Steve",
    uuid: "5627dd98-e6be-3c21-b8a8-e92344183641",
    accessToken: "0",
    xuid: "",
    clientId: "",
    userType: "legacy",
    launcherName: "Bloomery",
    launcherVersion: "1.0.1",
    width: 854,
    height: 480,
    rules: RULES,
};

test("占位符替换", () => {
    assert.equal(
        substitute("--username ${auth_player_name} --uuid ${auth_uuid}", CONTEXT),
        "--username Steve --uuid 5627dd98-e6be-3c21-b8a8-e92344183641",
    );
    assert.equal(
        substitute("${classpath_separator}", CONTEXT),
        process.platform === "win32" ? ";" : ":",
    );
    // 认不出的留着，便于从参数里发现
    assert.equal(substitute("${没有这个}", CONTEXT), "${没有这个}");
});

test("条件参数的 rules 过滤", () => {
    const descriptor = parseDescriptor(
        {
            id: "t",
            arguments: {
                game: [
                    "--username",
                    {
                        rules: [{ action: "allow", features: { is_demo_user: true } }],
                        value: "--demo",
                    },
                    {
                        rules: [{ action: "allow", features: { has_custom_resolution: true } }],
                        value: ["--width", "${resolution_width}"],
                    },
                ],
            },
        },
        "test",
        "t",
        "/tmp/t/t.json",
    );
    assert.ok(descriptor !== undefined);

    assert.deepEqual(expandArguments(descriptor.arguments.game, CONTEXT), [
        "--username",
        "--width",
        "854",
    ]);
});

test("1.13 起用 arguments 数组", () => {
    const descriptor = parseDescriptor(
        { id: "t", arguments: { game: ["--username", "${auth_player_name}"] } },
        "test",
        "t",
        "/tmp/t/t.json",
    );
    assert.ok(descriptor !== undefined);
    assert.deepEqual(buildGameArguments(descriptor, CONTEXT, ["--extra"]), [
        "--username",
        "Steve",
        "--extra",
    ]);
});

test("1.12.2 及以前用 minecraftArguments 字符串", () => {
    const descriptor = parseDescriptor(
        {
            id: "t",
            minecraftArguments: "--username ${auth_player_name}  --gameDir ${game_directory}",
        },
        "test",
        "t",
        "/tmp/t/t.json",
    );
    assert.ok(descriptor !== undefined);
    // 连续空白折叠
    assert.deepEqual(buildGameArguments(descriptor, CONTEXT, []), [
        "--username",
        "Steve",
        "--gameDir",
        "/games/versions/1.20.6",
    ]);
});

test("JVM 参数：内存在前，老版本自己补 classpath", () => {
    const modern = parseDescriptor(
        {
            id: "t",
            arguments: {
                jvm: [
                    "-Djava.library.path=${natives_directory}",
                    "-Dminecraft.launcher.brand=${launcher_name}",
                    "-cp",
                    "${classpath}",
                ],
            },
        },
        "test",
        "t",
        "/tmp/t/t.json",
    );
    assert.ok(modern !== undefined);
    const modernArgs = buildJvmArguments(modern, CONTEXT, { minMb: 512, maxMb: 4096 }, [
        "-XX:+UseG1GC",
    ]);
    assert.deepEqual(modernArgs, [
        "-Xms512M",
        "-Xmx4096M",
        // json 已经写了 brand，只补 version
        "-Dminecraft.launcher.version=1.0.1",
        "-Djava.library.path=/games/versions/1.20.6/natives",
        "-Dminecraft.launcher.brand=Bloomery",
        "-cp",
        "/a.jar:/b.jar",
        "-XX:+UseG1GC",
    ]);

    const old = parseDescriptor({ id: "t" }, "test", "t", "/tmp/t/t.json");
    assert.ok(old !== undefined);
    assert.deepEqual(buildJvmArguments(old, CONTEXT, { minMb: 1024, maxMb: 2048 }, []), [
        "-Xms1024M",
        "-Xmx2048M",
        "-Dminecraft.launcher.brand=Bloomery",
        "-Dminecraft.launcher.version=1.0.1",
        "-Djava.library.path=/games/versions/1.20.6/natives",
        "-cp",
        "/a.jar:/b.jar",
    ]);
});

test("借 --versionType 把启动器名挂到主界面左下角", () => {
    // 游戏拼成 Minecraft <版本>/<这个值>，斜杠由游戏加
    assert.equal(substitute("--versionType ${version_type}", CONTEXT), "--versionType Bloomery");
});

test("内存与窗口按三层取值", () => {
    const setting = defaultSetting();
    const withMemory = {
        ...setting,
        launch: {
            ...setting.launch,
            memory: { minMb: 512, maxMb: 4096 },
            window: { width: 854, height: 480, fullscreen: false },
            jvmArgs: ["-Dglobal=1"],
            gameArgs: ["--global"],
        },
    };

    const folder: Folder = {
        id: "f",
        path: "/games",
        autoDiscover: true,
        missingEntries: "keep",
        java: "/folder/java",
        memory: { maxMb: 6144 },
        instances: [],
    };
    const instance: Instance = {
        id: "i",
        target: "1.20.6",
        loader: { type: "vanilla", version: null },
        memory: { maxMb: 8192, minMb: 1024 },
        jvmArgs: ["-Dinstance=1"],
        gameArgs: ["--instance"],
        window: { width: 1280, height: 720, fullscreen: true },
    };

    const plain = launchOptionsOf(withMemory, folder, instance);
    assert.deepEqual(plain.memory, { minMb: 1024, maxMb: 8192 });
    assert.deepEqual(plain.window, { width: 1280, height: 720, fullscreen: true });
    assert.deepEqual(plain.jvmArgs, ["-Dglobal=1", "-Dinstance=1"]);
    assert.deepEqual(plain.gameArgs, ["--global", "--instance"]);
    // 实例没写 java，落到文件夹
    assert.equal(plain.javaPath, "/folder/java");

    // 开关打开就丢掉实例自己的值
    const global = launchOptionsOf(withMemory, folder, {
        ...instance,
        useGlobalSettings: {
            memory: true,
            window: true,
            jvmArgs: true,
            gameArgs: true,
            java: true,
        },
    });
    assert.deepEqual(global.memory, { minMb: 512, maxMb: 6144 });
    assert.deepEqual(global.window, { width: 854, height: 480, fullscreen: false });
    assert.deepEqual(global.jvmArgs, ["-Dglobal=1"]);
    assert.deepEqual(global.gameArgs, ["--global"]);
});

test("离线 UUID 与真实 Java 实现一致", () => {
    assert.equal(offlineUuid("Steve"), "5627dd98-e6be-3c21-b8a8-e92344183641");
    assert.equal(offlineUuid("Notch"), "b50ad385-829d-3141-a216-7e7d7539ba7f");
});

test("离线账户", () => {
    const accounts: Accounts = {
        schemaVersion: 1,
        accounts: [{ id: "offline:Steve", type: "offline", name: "Steve", uuid: null }],
    };
    const account = accountFor(accounts);
    assert.equal(account.name, "Steve");
    assert.equal(account.userType, "legacy");
    assert.equal(account.uuid, "5627dd98-e6be-3c21-b8a8-e92344183641");
    assert.equal(account.xuid, null);

    // 按名字指定
    assert.equal(accountFor(accounts, "Steve").id, "offline:Steve");
    assert.throws(() => accountFor(accounts, "没有这个人"), /AccountNotFound|找不到/);
});

test("微软账户缺凭据时报需要重登", () => {
    const microsoft: MicrosoftAccount = {
        id: "microsoft:Alex",
        type: "microsoft",
        name: "Alex",
        uuid: "00000000-0000-0000-0000-000000000001",
        xuid: "123",
        refreshToken: null,
        accessToken: null,
        expiresAt: null,
    };
    assert.throws(
        () => accountFor({ schemaVersion: 1, accounts: [microsoft] }),
        (error: unknown) => {
            return (error as { code?: string }).code === "AccountExpired";
        },
    );

    const fresh = accountFor({
        schemaVersion: 1,
        accounts: [
            {
                ...microsoft,
                refreshToken: "r",
                accessToken: "a",
                expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
        ],
    });
    assert.equal(fresh.userType, "msa");
    assert.equal(fresh.xuid, "123");
});

test("空账户清单", () => {
    assert.throws(
        () => accountFor({ schemaVersion: 1, accounts: [] }),
        (error: unknown) => {
            return (error as { code?: string }).code === "AccountNotFound";
        },
    );
});

test("退出码归一化", () => {
    assert.equal(exitCodeOf(0, null), 0);
    assert.equal(exitCodeOf(3, null), 3);
    assert.equal(exitCodeOf(null, "SIGTERM"), 128 + 15);
    assert.equal(exitCodeOf(null, null), 0);
});
