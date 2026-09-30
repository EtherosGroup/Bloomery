/**
 * 实例挑选：指定 > 当前选中 > 上次启动 > 第一个可用
 * @author IsCibocaz
 * @since 1.4.1
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { chooseInstance, type FolderView, type InstanceView } from "../../src/version/index.ts";

function instance(id: string, state: InstanceView["state"] = "ready"): InstanceView {
    return {
        id,
        name: id,
        target: "1.20.6",
        gameVersion: "1.20.6",
        loader: { type: "vanilla", version: null },
        directory: `/games/versions/${id}`,
        state,
        type: "release",
        descriptor: null,
        chain: [],
        configured: false,
        discovered: false,
        problem: null,
    } as InstanceView;
}

function view(instances: InstanceView[]): FolderView {
    return {
        id: "mc",
        name: "mc",
        path: "/games",
        exists: true,
        writable: true,
        versionsDirectory: "/games/versions",
        instances,
        dropped: [],
    } as FolderView;
}

const LIST = view([instance("1.20.6"), instance("1.20.6-fabric"), instance("1.21")]);

test("指定优先于选中与上次启动", () => {
    const pick = chooseInstance(LIST, "1.21", "1.20.6-fabric", "1.20.6");
    assert.equal(pick.instance?.id, "1.21");
    assert.equal(pick.source, "wanted");
});

test("没有指定时用当前选中的", () => {
    const pick = chooseInstance(LIST, undefined, "1.20.6-fabric", "1.20.6");
    assert.equal(pick.instance?.id, "1.20.6-fabric");
    assert.equal(pick.source, "selected");
});

test("选中的实例不在了退回上次启动", () => {
    const pick = chooseInstance(LIST, undefined, "gone", "1.21");
    assert.equal(pick.instance?.id, "1.21");
    assert.equal(pick.source, "last");
});

test("都没有时取第一个可用的", () => {
    const pick = chooseInstance(LIST, undefined, null, null);
    assert.equal(pick.instance?.id, "1.20.6");
    assert.equal(pick.source, "first");

    const broken = view([instance("bad", "broken")]);
    assert.equal(chooseInstance(broken, undefined, null, null).instance, undefined);
});
