/**
 * 微软登录
 *
 * 设备码授权拿 OAuth 令牌，再依次换 Xbox Live → XSTS → Minecraft 访问令牌
 * 前三步都在微软侧，只有 login_with_xbox 会校验 client id，自注册的应用通常在这里被 403 挡下
 * Minecraft 访问令牌按小时计时，用 refreshToken 换到新的 OAuth 令牌后必须重走后面三步
 * @author IsCibocaz
 * @since 1.1.6
 */

import { AppError } from "../error/index.ts";
import { httpForm, httpJson, sleep as sleepFor } from "../infra/http.ts";
import type { JsonResponse, NetworkOptions } from "../infra/http.ts";
import { logger } from "../output/index.ts";

const log = logger("auth");

const DEVICE_CODE_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBL_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const LOGIN_URL = "https://api.minecraftservices.com/authentication/login_with_xbox";
const PROFILE_URL = "https://api.minecraftservices.com/minecraft/profile";

const SCOPE = "XboxLive.signin offline_access";
const XSTS_RELYING_PARTY = "rp://api.minecraftservices.com/";

/** 换好的凭据，直接落到 accounts.json 的微软账号上 */
export interface MicrosoftCredentials {
    readonly refreshToken: string;
    readonly accessToken: string;
    readonly expiresAt: string;
    readonly uuid: string;
    readonly name: string;
    readonly xuid: string | null;
}

export interface DeviceCodePrompt {
    readonly url: string;
    readonly code: string;
    readonly expiresIn: number;
}

// 传输层：默认走 infra/http，测试注入假实现
// encoding 是给微软 OAuth 端点用的，那边只认表单，Xbox 与 Minecraft 收 JSON
export type Transport = (
    method: "GET" | "POST",
    url: string,
    payload: unknown,
    options: NetworkOptions,
    encoding?: "json" | "form",
) => Promise<JsonResponse>;

const defaultTransport: Transport = (method, url, payload, options, encoding) =>
    encoding === "form"
        ? httpForm(url, (payload ?? {}) as Record<string, string>, options)
        : httpJson(method, url, payload, options);

export interface LoginInput {
    readonly clientId: string;
    readonly network: NetworkOptions;
    /** 把设备码交给调用方打印 */
    readonly prompt: (info: DeviceCodePrompt) => void;
    readonly transport?: Transport;
    readonly wait?: (ms: number) => Promise<void>;
}

export interface RefreshInput {
    readonly clientId: string;
    readonly refreshToken: string;
    readonly network: NetworkOptions;
    readonly transport?: Transport;
}

export async function loginMicrosoft(input: LoginInput): Promise<MicrosoftCredentials> {
    const transport = input.transport ?? defaultTransport;
    const wait = input.wait ?? sleepFor;

    const device = await requestDeviceCode(transport, input.clientId, input.network);
    input.prompt({
        url: device.verificationUri,
        code: device.userCode,
        expiresIn: device.expiresIn,
    });

    const oauth = await pollToken(transport, {
        clientId: input.clientId,
        deviceCode: device.deviceCode,
        intervalMs: device.intervalMs,
        expiresAt: Date.now() + device.expiresIn * 1000,
        network: input.network,
        wait,
    });

    return finish(transport, oauth, input.network);
}

export async function refreshMicrosoft(input: RefreshInput): Promise<MicrosoftCredentials> {
    const transport = input.transport ?? defaultTransport;
    const response = await transport(
        "POST",
        TOKEN_URL,
        {
            client_id: input.clientId,
            grant_type: "refresh_token",
            refresh_token: input.refreshToken,
            scope: SCOPE,
        },
        input.network,
        "form",
    );

    const oauth = oauthToken(response, input.refreshToken);
    return finish(transport, oauth, input.network);
}

/* ---------- 设备码 ---------- */

interface DeviceCode {
    readonly deviceCode: string;
    readonly userCode: string;
    readonly verificationUri: string;
    readonly expiresIn: number;
    readonly intervalMs: number;
}

interface OAuthToken {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresIn: number;
}

async function requestDeviceCode(
    transport: Transport,
    clientId: string,
    network: NetworkOptions,
): Promise<DeviceCode> {
    const response = await transport(
        "POST",
        DEVICE_CODE_URL,
        { client_id: clientId, scope: SCOPE },
        network,
        "form",
    );
    const body = record(response.body);

    if (response.status >= 400) {
        const detail = field(body, "error_description") ?? field(body, "error") ?? "";
        log.warn("设备码申请失败：HTTP %d %s", response.status, detail);
        throw new AppError("auth", "MicrosoftLoginFailed", {
            context: { detail: "申请设备码被拒", status: response.status, reason: detail },
        });
    }

    const deviceCode = field(body, "device_code");
    const userCode = field(body, "user_code");
    if (deviceCode === undefined || userCode === undefined) {
        throw new AppError("auth", "MicrosoftLoginFailed", {
            context: { detail: "设备码响应里没有 device_code" },
        });
    }

    return {
        deviceCode,
        userCode,
        verificationUri: field(body, "verification_uri") ?? "https://microsoft.com/link",
        expiresIn: number(body, "expires_in") ?? 900,
        intervalMs: (number(body, "interval") ?? 5) * 1000,
    };
}

interface PollInput {
    readonly clientId: string;
    readonly deviceCode: string;
    readonly intervalMs: number;
    readonly expiresAt: number;
    readonly network: NetworkOptions;
    readonly wait: (ms: number) => Promise<void>;
}

// 授权没完成时微软回 400 + authorization_pending，按 interval 继续问
async function pollToken(transport: Transport, input: PollInput): Promise<OAuthToken> {
    let interval = input.intervalMs;

    for (;;) {
        if (Date.now() >= input.expiresAt) {
            throw new AppError("auth", "MicrosoftLoginFailed", {
                context: { detail: "设备码超时，请重新登录" },
            });
        }
        await input.wait(interval);

        const response = await transport(
            "POST",
            TOKEN_URL,
            {
                client_id: input.clientId,
                grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                device_code: input.deviceCode,
            },
            input.network,
            "form",
        );
        if (response.status < 400) {
            return oauthToken(response);
        }

        const error = field(record(response.body), "error") ?? "";
        switch (error) {
            case "authorization_pending":
                continue;
            case "slow_down":
                // 微软要求放慢轮询，按它的提示加一拍
                interval += 5000;
                continue;
            case "expired_token":
                throw new AppError("auth", "MicrosoftLoginFailed", {
                    context: { detail: "设备码已过期，请重新登录" },
                });
            case "authorization_declined":
                throw new AppError("auth", "MicrosoftLoginFailed", {
                    context: { detail: "授权被拒绝" },
                });
            default:
                throw new AppError("auth", "MicrosoftLoginFailed", {
                    context: { detail: "换令牌失败", status: response.status, reason: error },
                });
        }
    }
}

function oauthToken(response: JsonResponse, previous?: string): OAuthToken {
    const body = record(response.body);
    const accessToken = field(body, "access_token");
    const refreshToken = field(body, "refresh_token");
    if (response.status >= 400 || accessToken === undefined) {
        const detail = field(body, "error_description") ?? field(body, "error") ?? "";
        throw new AppError("auth", "AccountExpired", {
            context: { detail: detail === "" ? "刷新令牌已失效，请重新登录" : detail },
        });
    }
    return {
        accessToken,
        // 刷新响应有时不带新的 refresh token，沿用旧的
        refreshToken: refreshToken ?? previous ?? "",
        expiresIn: number(body, "expires_in") ?? 86_400,
    };
}

/* ---------- Xbox 与 Minecraft ---------- */

interface XblToken {
    readonly token: string;
    readonly userHash: string;
}

async function xboxLive(
    transport: Transport,
    accessToken: string,
    network: NetworkOptions,
): Promise<XblToken> {
    const response = await transport(
        "POST",
        XBL_URL,
        {
            Properties: {
                AuthMethod: "RPS",
                SiteName: "user.auth.xboxlive.com",
                RpsTicket: `d=${accessToken}`,
            },
            RelyingParty: "http://auth.xboxlive.com",
            TokenType: "JWT",
        },
        network,
    );
    const body = record(response.body);
    const token = field(body, "Token");
    const userHash = claimsUserHash(body);
    if (response.status >= 400 || token === undefined || userHash === undefined) {
        throw new AppError("auth", "MicrosoftLoginFailed", {
            context: { detail: "Xbox Live 认证失败", status: response.status },
        });
    }
    return { token, userHash };
}

async function xstsToken(
    transport: Transport,
    xblToken: string,
    network: NetworkOptions,
): Promise<XblToken> {
    const response = await transport(
        "POST",
        XSTS_URL,
        {
            Properties: { SandboxId: "RETAIL", UserTokens: [xblToken] },
            RelyingParty: XSTS_RELYING_PARTY,
            TokenType: "JWT",
        },
        network,
    );
    const body = record(response.body);
    const token = field(body, "Token");
    const userHash = claimsUserHash(body);
    if (response.status >= 400 || token === undefined || userHash === undefined) {
        throw new AppError("auth", "MicrosoftLoginFailed", {
            context: { detail: xstsReason(number(body, "XErr")), status: response.status },
        });
    }
    return { token, userHash };
}

// XSTS 的 XErr 码，官方文档与各家启动器口径一致
function xstsReason(code: number | undefined): string {
    switch (code) {
        case 2_148_916_233:
            return "这个微软账户还没有 Xbox 档案，先去 xbox.com 建一个";
        case 2_148_916_235:
            return "这个账户所在地区不支持 Xbox Live";
        case 2_148_916_236:
        case 2_148_916_237:
            return "这个账户需要先在 Xbox 页面完成成人验证";
        case 2_148_916_238:
            return "未成年账户需要先加入 Microsoft 家庭组";
        default:
            return code === undefined ? "XSTS 授权失败" : `XSTS 授权失败（XErr ${code}）`;
    }
}

async function loginWithXbox(
    transport: Transport,
    xsts: XblToken,
    network: NetworkOptions,
): Promise<{ token: string; expiresIn: number }> {
    const response = await transport(
        "POST",
        LOGIN_URL,
        { identityToken: `XBL3.0 x=${xsts.userHash};${xsts.token}` },
        network,
    );
    const body = record(response.body);
    const accessToken = field(body, "access_token");
    if (response.status >= 400 || accessToken === undefined) {
        const text = typeof response.body === "string" ? response.body : "";
        const rejected = response.status === 403 && text.includes("Invalid app registration");
        throw new AppError("auth", "MicrosoftLoginFailed", {
            context: {
                detail: rejected
                    ? "Minecraft 服务不认这个 client id（Invalid app registration）"
                    : "Minecraft 登录失败",
                status: response.status,
                reason: field(body, "error") ?? text.slice(0, 120),
            },
        });
    }
    return { token: accessToken, expiresIn: number(body, "expires_in") ?? 86_400 };
}

interface Profile {
    readonly uuid: string;
    readonly name: string;
}

async function profileOf(
    transport: Transport,
    accessToken: string,
    network: NetworkOptions,
): Promise<Profile> {
    const response = await transport("GET", PROFILE_URL, undefined, {
        ...network,
        headers: { ...network.headers, authorization: `Bearer ${accessToken}` },
    });
    const body = record(response.body);

    if (response.status === 404) {
        throw new AppError("auth", "MicrosoftNotOwned", {
            context: { detail: "这个微软账户没有 Minecraft: Java Edition" },
        });
    }
    const id = field(body, "id");
    const name = field(body, "name");
    if (response.status >= 400 || id === undefined || name === undefined) {
        throw new AppError("auth", "MicrosoftLoginFailed", {
            context: { detail: "拉取游戏档案失败", status: response.status },
        });
    }
    return { uuid: id, name };
}

// 从 OAuth 令牌一路换到游戏档案
async function finish(
    transport: Transport,
    oauth: OAuthToken,
    network: NetworkOptions,
): Promise<MicrosoftCredentials> {
    const xbl = await xboxLive(transport, oauth.accessToken, network);
    const xsts = await xstsToken(transport, xbl.token, network);
    const minecraft = await loginWithXbox(transport, xsts, network);
    const profile = await profileOf(transport, minecraft.token, network);

    log.debug("登录到 %s（%s）", profile.name, profile.uuid);
    return {
        refreshToken: oauth.refreshToken,
        accessToken: minecraft.token,
        // 过期时间按 Minecraft 令牌自己的寿命算，OAuth 与它不是一个时长
        expiresAt: new Date(Date.now() + minecraft.expiresIn * 1000).toISOString(),
        uuid: profile.uuid,
        name: profile.name,
        xuid: xsts.userHash,
    };
}

/* ---------- 小工具 ---------- */

function record(value: unknown): Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function field(container: Record<string, unknown>, key: string): string | undefined {
    const value = container[key];
    return typeof value === "string" && value !== "" ? value : undefined;
}

function number(container: Record<string, unknown>, key: string): number | undefined {
    const value = container[key];
    return typeof value === "number" ? value : undefined;
}

// Xbox 的 DisplayClaims.xui 是数组，取第一项的 uhs
function claimsUserHash(body: Record<string, unknown>): string | undefined {
    const claims = record(body["DisplayClaims"]);
    const xui = claims["xui"];
    const first = Array.isArray(xui) ? xui[0] : undefined;
    return field(record(first), "uhs");
}
