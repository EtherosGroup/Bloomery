/*
 * 默认值
 *
 * 这里是默认值的唯一来源；schema 里的 default 只是给编辑器的提示
 * 字段顺序与 schema 一致，写出的 JSON 才有稳定的键序
 */

import { CURRENT_SCHEMA, type Accounts, type Setting, type State } from "./types.ts";

export function defaultSetting(): Setting {
    return {
        schemaVersion: CURRENT_SCHEMA,
        language: "system",
        appearance: { color: "auto", unicode: true, progress: "bar" },
        log: { enabled: true, level: "info", directory: null, keep: -1 },
        network: {
            proxy: null,
            noProxy: ["localhost", "127.0.0.1", "::1"],
            timeoutMs: 15000,
            retries: 3,
            concurrency: 8,
        },
        download: {
            verify: "strict",
            sources: [
                { provider: "official", enabled: true, url: null },
                {
                    provider: "bmclapi",
                    enabled: false,
                    url: "https://bmclapi2.bangbang93.com",
                },
            ],
        },
        java: { autoDetect: true, autoDownload: true, runtimeDirectory: null, list: [] },
        launch: {
            memory: { minMb: 512, maxMb: 4096 },
            window: { width: 854, height: 480, fullscreen: false },
            jvmArgs: [],
            gameArgs: [],
            waitForExit: true,
        },
        mod: { provider: "modrinth", installDependencies: true },
        cleanup: { orphan: "ask" },
        selectedAccount: null,
        selectedFolder: null,
        folders: [],
    };
}

export function defaultAccounts(): Accounts {
    return { schemaVersion: CURRENT_SCHEMA, accounts: [] };
}

export function defaultState(): State {
    return {
        schemaVersion: CURRENT_SCHEMA,
        lastFolder: null,
        lastInstance: null,
        instances: {},
        javaProbe: {},
    };
}
