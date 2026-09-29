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

test("微软账号先记一条没有凭据的", () => {
    const account = microsoftAccount("cibocaz");
    assert.equal(account.id, "cibocaz@microsoft");
    assert.equal(account.type, "microsoft");
    assert.equal(account.refreshToken, null);
    assert.equal(account.accessToken, null);
    assert.equal(account.expiresAt, null);
});
