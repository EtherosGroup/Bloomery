/**
 * 微软登录链路：设备码、轮询与后续兑换
 * @author IsCibocaz
 * @since 1.1.6
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loginMicrosoft, refreshMicrosoft, type Transport } from "../../src/auth/index.ts";
import { AppError } from "../../src/error/index.ts";
import type { JsonResponse } from "../../src/infra/http.ts";

const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const LOGIN_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";

const NETWORK = { timeoutMs: 1000, retries: 0 };

const DEVICE: JsonResponse = {
    status: 200,
    body: {
        device_code: "dev-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://microsoft.com/link",
        expires_in: 900,
        interval: 0,
    },
};
const OAUTH: JsonResponse = {
    status: 200,
    body: { access_token: "oauth-1", refresh_token: "refresh-1", expires_in: 3600 },
};
const XBL: JsonResponse = {
    status: 200,
    body: { Token: "xbl-1", DisplayClaims: { xui: [{ uhs: "u-1" }] } },
};
const XSTS: JsonResponse = {
    status: 200,
    body: { Token: "xsts-1", DisplayClaims: { xui: [{ uhs: "u-1" }] } },
};
const MINECRAFT: JsonResponse = { status: 200, body: { access_token: "mc-1", expires_in: 86_400 } };
const PROFILE: JsonResponse = { status: 200, body: { id: "uuid-1", name: "Steve" } };

interface Call {
    readonly method: string;
    readonly url: string;
    readonly payload: unknown;
    readonly encoding: string | undefined;
}

// 按 URL 回放预设响应，多个响应按顺序取；顺便记下每次调用
function fake(
    responses: Readonly<Record<string, JsonResponse | readonly JsonResponse[]>>,
    calls: Call[],
): Transport {
    const queues = new Map<string, JsonResponse[]>();
    for (const [url, value] of Object.entries(responses)) {
        queues.set(url, Array.isArray(value) ? [...value] : [value as JsonResponse]);
    }
    return async (method, url, payload, _options, encoding) => {
        calls.push({ method, url, payload, encoding });
        const next = queues.get(url)?.shift();
        if (next === undefined) {
            throw new Error(`没有为 ${url} 准备响应`);
        }
        return next;
    };
}

function callTo(calls: readonly Call[], url: string): Call {
    const found = calls.find((call) => call.url === url);
    assert.ok(found !== undefined, `没有请求 ${url}`);
    return found;
}

const HAPPY: Readonly<Record<string, JsonResponse>> = {
    [DEVICE_CODE_URL]: DEVICE,
    [TOKEN_URL]: OAUTH,
    [XBL_URL]: XBL,
    [XSTS_URL]: XSTS,
    [LOGIN_URL]: MINECRAFT,
    [PROFILE_URL]: PROFILE,
};

test("设备码登录兑换到游戏档案", async () => {
    const calls: Call[] = [];
    const prompts: Array<{ url: string; code: string }> = [];
    const credentials = await loginMicrosoft({
        clientId: "client-1",
        network: NETWORK,
        transport: fake(HAPPY, calls),
        wait: async () => {},
        prompt: (info) => prompts.push({ url: info.url, code: info.code }),
    });

    assert.deepEqual(prompts, [{ url: "https://microsoft.com/link", code: "ABCD-EFGH" }]);
    assert.equal(credentials.name, "Steve");
    assert.equal(credentials.uuid, "uuid-1");
    assert.equal(credentials.xuid, "u-1");
    assert.equal(credentials.accessToken, "mc-1");
    assert.equal(credentials.refreshToken, "refresh-1");
    assert.ok(Date.parse(credentials.expiresAt) > Date.now());

    // 两处写法是协议规定的：RpsTicket 加 d= 前缀，identityToken 是 XBL3.0 x=<uhs>;<xsts>
    const xbl = callTo(calls, XBL_URL).payload as { Properties: { RpsTicket: string } };
    assert.equal(xbl.Properties.RpsTicket, "d=oauth-1");
    const login = callTo(calls, LOGIN_URL).payload as { identityToken: string };
    assert.equal(login.identityToken, "XBL3.0 x=u-1;xsts-1");
    assert.equal(callTo(calls, PROFILE_URL).method, "GET");
    // 微软 OAuth 端点收表单，Xbox 那边收 JSON
    assert.equal(callTo(calls, DEVICE_CODE_URL).encoding, "form");
    assert.equal(callTo(calls, TOKEN_URL).encoding, "form");
    assert.equal(callTo(calls, XBL_URL).encoding, undefined);
});

test("轮询：pending 与 slow_down 之后拿到令牌", async () => {
    const calls: Call[] = [];
    const waits: number[] = [];
    const credentials = await loginMicrosoft({
        clientId: "client-1",
        network: NETWORK,
        transport: fake(
            {
                ...HAPPY,
                [TOKEN_URL]: [
                    { status: 400, body: { error: "authorization_pending" } },
                    { status: 400, body: { error: "slow_down" } },
                    OAUTH,
                ],
            },
            calls,
        ),
        wait: async (ms) => {
            waits.push(ms);
        },
        prompt: () => {},
    });

    assert.equal(credentials.accessToken, "mc-1");
    // 三次轮询：0、0、放慢后的 5000
    assert.deepEqual(waits, [0, 0, 5000]);
});

test("设备码过期与授权被拒都报登录失败", async () => {
    for (const error of ["expired_token", "authorization_declined"]) {
        const calls: Call[] = [];
        await assert.rejects(
            loginMicrosoft({
                clientId: "client-1",
                network: NETWORK,
                transport: fake({ ...HAPPY, [TOKEN_URL]: { status: 400, body: { error } } }, calls),
                wait: async () => {},
                prompt: () => {},
            }),
            (thrown: unknown) => {
                assert.ok(thrown instanceof AppError);
                assert.equal(thrown.code, "MicrosoftLoginFailed");
                return true;
            },
            error,
        );
    }
});

test("XSTS 的 XErr 码翻译成人话", async () => {
    const calls: Call[] = [];
    await assert.rejects(
        loginMicrosoft({
            clientId: "client-1",
            network: NETWORK,
            transport: fake(
                {
                    ...HAPPY,
                    [XSTS_URL]: {
                        status: 401,
                        body: { Identity: "0", XErr: 2_148_916_233, Message: "" },
                    },
                },
                calls,
            ),
            wait: async () => {},
            prompt: () => {},
        }),
        (thrown: unknown) => {
            assert.ok(thrown instanceof AppError);
            assert.match(String(thrown.context["detail"]), /Xbox 档案/);
            return true;
        },
    );
});

test("client id 被拒时把 Invalid app registration 说出来", async () => {
    const calls: Call[] = [];
    await assert.rejects(
        loginMicrosoft({
            clientId: "client-1",
            network: NETWORK,
            transport: fake(
                {
                    ...HAPPY,
                    [LOGIN_URL]: {
                        status: 403,
                        body: "Invalid app registration, see https://aka.ms/AppRegInfo",
                    },
                },
                calls,
            ),
            wait: async () => {},
            prompt: () => {},
        }),
        (thrown: unknown) => {
            assert.ok(thrown instanceof AppError);
            assert.match(String(thrown.context["detail"]), /client id/);
            return true;
        },
    );
});

test("没有游戏时单独报出来", async () => {
    const calls: Call[] = [];
    await assert.rejects(
        loginMicrosoft({
            clientId: "client-1",
            network: NETWORK,
            transport: fake({ ...HAPPY, [PROFILE_URL]: { status: 404, body: {} } }, calls),
            wait: async () => {},
            prompt: () => {},
        }),
        (thrown: unknown) => {
            assert.ok(thrown instanceof AppError);
            assert.equal(thrown.code, "MicrosoftNotOwned");
            return true;
        },
    );
});

test("续期不重走设备码，响应没带新刷新令牌时沿用旧的", async () => {
    const calls: Call[] = [];
    const credentials = await refreshMicrosoft({
        clientId: "client-1",
        refreshToken: "old-refresh",
        network: NETWORK,
        transport: fake(
            {
                ...HAPPY,
                [TOKEN_URL]: { status: 200, body: { access_token: "oauth-2", expires_in: 3600 } },
            },
            calls,
        ),
    });

    assert.equal(credentials.refreshToken, "old-refresh");
    assert.equal(credentials.accessToken, "mc-1");
    assert.equal(
        calls.some((call) => call.url === DEVICE_CODE_URL),
        false,
    );
    const token = callTo(calls, TOKEN_URL).payload as { grant_type: string };
    assert.equal(token.grant_type, "refresh_token");
});
