/**
 * 启动账户：离线 UUID 推导、微软续期判定与挑选
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { Account } from "../../src/config/types.ts";
import { needsRefresh, offlineUuid, pickAccount } from "../../src/launch/index.ts";

const MICROSOFT: Account = {
    id: "cibocaz@microsoft",
    type: "microsoft",
    name: "cibocaz",
    uuid: "5c103697-2f61-3499-8df5-6c1e4c671e80",
    xuid: "2535410000000000",
    refreshToken: "refresh-1",
    accessToken: "access-1",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    clientId: "client-1",
};

const OFFLINE: Account = { id: "cibocaz@offline", type: "offline", name: "cibocaz", uuid: null };

test("离线 UUID 形态正确且与名字绑定", () => {
    const uuid = offlineUuid("cibocaz");
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(offlineUuid("cibocaz"), uuid);
    assert.notEqual(offlineUuid("Steve"), uuid);
});

test("微软账户该不该续期", () => {
    assert.equal(needsRefresh(MICROSOFT), false);
    // 过期了要续
    assert.equal(
        needsRefresh({ ...MICROSOFT, expiresAt: new Date(Date.now() - 1000).toISOString() }),
        true,
    );
    // 一分钟余量之内也算要续
    assert.equal(
        needsRefresh({ ...MICROSOFT, expiresAt: new Date(Date.now() + 10_000).toISOString() }),
        true,
    );
    // 没写过期时间当作已过期
    assert.equal(needsRefresh({ ...MICROSOFT, expiresAt: null }), true);
    // 没有 refreshToken 或 clientId 就谈不上续，交给启动时报需要重新登录
    assert.equal(needsRefresh({ ...MICROSOFT, refreshToken: null }), false);
    assert.equal(needsRefresh({ ...MICROSOFT, clientId: null }), false);
    assert.equal(needsRefresh(OFFLINE), false);
});

test("账户挑选：id 优先于名字，其次配置里选的", () => {
    const list = [OFFLINE, MICROSOFT];
    assert.equal(pickAccount(list, "cibocaz@microsoft", null)?.id, "cibocaz@microsoft");
    assert.equal(pickAccount(list, undefined, "cibocaz@microsoft")?.id, "cibocaz@microsoft");
    // 只给游戏名时挑到先来的那条
    assert.equal(pickAccount(list, "cibocaz", null)?.id, "cibocaz@offline");
    // 配置里选的那条不在了就退回第一个
    assert.equal(pickAccount(list, undefined, "gone@microsoft")?.id, "cibocaz@offline");
    assert.equal(pickAccount([], undefined, null), undefined);
});
