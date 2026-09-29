/**
 * 账号 id 与构造
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { accountId, microsoftAccount, offlineAccount } from "../../src/config/accounts.ts";

test("账号 id 是 <游戏名>@<类型>", () => {
    assert.equal(accountId("cibocaz", "offline"), "cibocaz@offline");
    assert.equal(accountId("cibocaz", "microsoft"), "cibocaz@microsoft");
    // 同一个游戏名 + 不同类型是两条，不会撞
    assert.notEqual(accountId("cibocaz", "offline"), accountId("cibocaz", "microsoft"));
});

test("离线账号", () => {
    const account = offlineAccount("cibocaz");
    assert.equal(account.id, "cibocaz@offline");
    assert.equal(account.type, "offline");
    assert.equal(account.name, "cibocaz");
    // uuid 交给启动时按名字推
    assert.equal(account.uuid, null);
});

test("微软账号带凭据与 client id", () => {
    const account = microsoftAccount("cibocaz", "client-id-1", {
        uuid: "5c103697-2f61-3499-8df5-6c1e4c671e80",
        xuid: "2535410000000000",
        refreshToken: "refresh-1",
        accessToken: "access-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
    });
    assert.equal(account.id, "cibocaz@microsoft");
    assert.equal(account.type, "microsoft");
    assert.equal(account.refreshToken, "refresh-1");
    assert.equal(account.accessToken, "access-1");
    assert.equal(account.expiresAt, "2030-01-01T00:00:00.000Z");
    assert.equal(account.xuid, "2535410000000000");
    // client id 与 refreshToken 配对，续期要用同一个
    assert.equal(account.clientId, "client-id-1");
});
