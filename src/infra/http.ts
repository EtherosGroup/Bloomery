/**
 * HTTP 请求
 *
 * 直接用 node:http / node:https 发，不引第三方库，超时、代理、重定向才有地方下手
 * 重试只针对网络错误、429 与 5xx；4xx 是明确的拒绝，重试没有意义
 * 代理只认 http 代理：https 走 CONNECT 隧道，http 用绝对地址请求
 * @author IsCibocaz
 * @since 1.0.0
 */

import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ClientRequest } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { request as httpsRequest } from "node:https";
import { connect as tlsConnect } from "node:tls";
import type { Readable } from "node:stream";

import { logger } from "../output/index.ts";
import { packageVersion } from "./package.ts";

const log = logger("http");

const MAX_REDIRECTS = 5;
const MAX_BUFFER = 64 * 1024 * 1024;
const USER_AGENT = `bloomery/${packageVersion()}`;

export interface NetworkOptions {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly proxy?: string | null;
    readonly noProxy?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
    /** 默认 GET */
    readonly method?: string;
    /** 请求体，有它就按 JSON 发 */
    readonly body?: Buffer;
}

export interface JsonResponse {
    readonly status: number;
    readonly body: unknown;
}

export interface HttpResponse {
    readonly url: string;
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly stream: Readable;
}

// 明确的 HTTP 失败，调用方据此决定重试还是放弃
export class HttpStatusError extends Error {
    readonly status: number;
    readonly url: string;

    constructor(status: number, url: string) {
        super(`HTTP ${status} ${url}`);
        this.name = "HttpStatusError";
        this.status = status;
        this.url = url;
    }
}

// 单次请求，跟随重定向。重试放在能看到完整正文的那一层，卡在正文中间也会重来
export async function httpGet(url: string, options: NetworkOptions): Promise<HttpResponse> {
    const response = await follow(url, options, 0);
    if (response.status >= 400) {
        // 不读掉的连接会一直占着
        response.stream.resume();
        throw new HttpStatusError(response.status, url);
    }
    return response;
}

// 4xx 是明确的拒绝，重试没有意义
export function retryable(error: unknown): boolean {
    return !(error instanceof HttpStatusError) || error.status >= 500;
}

export async function httpGetBuffer(url: string, options: NetworkOptions): Promise<Buffer> {
    const attempts = Math.max(0, options.retries) + 1;
    let last: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await httpGet(url, options);
            return await readAll(response.stream, MAX_BUFFER);
        } catch (error) {
            last = error;
            if (!retryable(error)) {
                throw error;
            }
            if (attempt < attempts) {
                log.debug("%s 第 %d 次失败，重试：%s", url, attempt, message(error));
                await sleep(300 * attempt);
            }
        }
    }

    throw last instanceof Error ? last : new Error(String(last));
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// 单次 JSON 请求：4xx 也把正文交回调用方，OAuth 的 authorization_pending 就在 400 的正文里
export async function httpJson(
    method: "GET" | "POST",
    url: string,
    payload: unknown,
    options: NetworkOptions,
): Promise<JsonResponse> {
    const body = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload), "utf8");
    return requestJson(method, url, body, options);
}

// 表单请求：微软的 OAuth 端点只认 application/x-www-form-urlencoded
export async function httpForm(
    url: string,
    fields: Readonly<Record<string, string>>,
    options: NetworkOptions,
): Promise<JsonResponse> {
    const body = Buffer.from(new URLSearchParams(fields).toString(), "utf8");
    const headers = {
        ...options.headers,
        "content-type": "application/x-www-form-urlencoded",
    };
    return requestJson("POST", url, body, { ...options, headers });
}

async function requestJson(
    method: "GET" | "POST",
    url: string,
    body: Buffer | undefined,
    options: NetworkOptions,
): Promise<JsonResponse> {
    const attempts = Math.max(0, options.retries) + 1;
    let last: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await follow(url, { ...options, method, body }, 0);
            const text = (await readAll(response.stream, MAX_BUFFER)).toString("utf8");
            return { status: response.status, body: parseBody(text) };
        } catch (error) {
            last = error;
            if (!retryable(error)) {
                throw error;
            }
            if (attempt < attempts) {
                log.debug("%s 第 %d 次失败，重试：%s", url, attempt, message(error));
                await sleep(300 * attempt);
            }
        }
    }

    throw last instanceof Error ? last : new Error(String(last));
}

function parseBody(text: string): unknown {
    if (text === "") {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        // 非 JSON 的正文原样交出去，报错时能带上
        return text;
    }
}

/* ---------- 内部 ---------- */

async function follow(
    url: string,
    options: NetworkOptions,
    redirects: number,
): Promise<HttpResponse> {
    const target = new URL(url);
    const response = await send(target, options);

    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location !== undefined) {
        response.stream.resume();
        if (redirects >= MAX_REDIRECTS) {
            throw new Error(`重定向次数过多：${url}`);
        }
        // 重定向后按 GET 重发，请求体不再带上
        const next = { ...options, method: "GET", body: undefined };
        return follow(new URL(location, target).href, next, redirects + 1);
    }

    return { url, status: response.status, headers: response.headers, stream: response.stream };
}

interface RawResponse {
    readonly status: number;
    readonly headers: IncomingHttpHeaders;
    readonly stream: Readable;
}

function send(target: URL, options: NetworkOptions): Promise<RawResponse> {
    return new Promise((resolve, reject) => {
        const secure = target.protocol === "https:";
        const proxy = proxyFor(target, options);
        const method = options.method ?? "GET";
        const headers: Record<string, string> = {
            "user-agent": USER_AGENT,
            accept: "*/*",
            "accept-encoding": "identity",
            ...options.headers,
        };
        if (options.body !== undefined) {
            headers["content-type"] = headers["content-type"] ?? "application/json";
            headers["content-length"] = String(options.body.length);
        }

        let request: ClientRequest;
        let response: IncomingMessage | undefined;
        let connectTimer: NodeJS.Timeout | undefined;

        const clearConnect = (): void => {
            if (connectTimer !== undefined) {
                clearTimeout(connectTimer);
                connectTimer = undefined;
            }
        };

        const onResponse = (incoming: IncomingMessage): void => {
            response = incoming;
            resolve({
                status: incoming.statusCode ?? 0,
                headers: incoming.headers,
                stream: incoming,
            });
        };

        if (proxy !== undefined && !secure) {
            // http 走代理：请求行里放绝对地址
            const port = proxy.port === "" ? 80 : Number(proxy.port);
            request = httpRequest(
                {
                    host: proxy.hostname,
                    port,
                    path: target.href,
                    method,
                    headers: { ...headers, host: target.host },
                    // 不复用连接：空闲超时挂在 socket 上，连接回池后容易误伤下一个请求
                    agent: false,
                },
                onResponse,
            );
        } else if (proxy !== undefined) {
            request = httpsRequest(
                {
                    host: target.hostname,
                    port: target.port === "" ? 443 : Number(target.port),
                    path: `${target.pathname}${target.search}`,
                    method,
                    headers,
                    agent: false,
                    createConnection: (_opts, callback) => {
                        tunnel(proxy, target, (error, socket) => {
                            if (error !== null) {
                                callback(error, undefined as unknown as Socket);
                                return;
                            }
                            // https 层自己在这个裸 socket 上再包 TLS
                            callback(null, socket as Socket);
                        });
                    },
                },
                onResponse,
            );
        } else {
            const port = target.port === "" ? (secure ? 443 : 80) : Number(target.port);
            const send = secure ? httpsRequest : httpRequest;
            request = send(
                {
                    host: target.hostname,
                    port,
                    path: `${target.pathname}${target.search}`,
                    method,
                    headers,
                    agent: false,
                },
                onResponse,
            );
        }

        // 建连阶段自己计时：request.setTimeout 要等 socket 连上才武装，TCP 被黑洞时永远不触发
        connectTimer = setTimeout(() => {
            clearConnect();
            request.destroy(new Error(`连接超时（${options.timeoutMs}ms）：${target.href}`));
        }, options.timeoutMs);

        // 连上之后交给 socket 的空闲超时，它有动静就自动重置。
        // 不要在 response 上挂 data 监听来重置：那会把与响应头同批到达的正文冲掉
        request.setTimeout(options.timeoutMs, () => {
            const error = new Error(`请求空闲超过 ${options.timeoutMs}ms：${target.href}`);
            if (response !== undefined) {
                response.destroy(error);
            } else {
                request.destroy(error);
            }
        });

        request.on("socket", (socket) => {
            socket.once("connect", clearConnect);
            socket.once("secureConnect", clearConnect);
            socket.once("close", clearConnect);
        });
        request.on("error", (error) => {
            clearConnect();
            reject(error);
        });
        request.on("close", clearConnect);
        request.end(options.body);
    });
}

// CONNECT 隧道：先跟代理建连，拿到 200 之后把裸 socket 交出去
function tunnel(
    proxy: URL,
    target: URL,
    callback: (error: Error | null, socket?: Socket) => void,
): void {
    const port = proxy.port === "" ? 80 : Number(proxy.port);
    const authority = `${target.hostname}:${target.port === "" ? 443 : target.port}`;
    const socket = netConnect({ host: proxy.hostname, port });

    let settled = false;
    const fail = (error: Error): void => {
        if (settled) {
            return;
        }
        settled = true;
        socket.destroy();
        callback(error);
    };

    socket.on("error", fail);
    socket.on("connect", () => {
        const auth =
            proxy.username === ""
                ? ""
                : `Proxy-Authorization: Basic ${Buffer.from(
                      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
                  ).toString("base64")}\r\n`;
        socket.write(
            `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}Proxy-Connection: keep-alive\r\n\r\n`,
        );
    });

    let buffer = "";
    const onData = (chunk: Buffer): void => {
        buffer += chunk.toString("latin1");
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) {
            return;
        }
        socket.off("data", onData);

        const status = Number.parseInt(buffer.slice(buffer.indexOf(" ") + 1), 10);
        if (status !== 200) {
            fail(new Error(`代理 CONNECT 返回 ${status}`));
            return;
        }
        settled = true;
        const rest = buffer.slice(end + 4);
        if (rest !== "") {
            socket.unshift(Buffer.from(rest, "latin1"));
        }
        callback(null, socket);
    };
    socket.on("data", onData);
}

// 代理只对该走的地址生效：配置里没写就看环境变量，noProxy 里的直连
function proxyFor(target: URL, options: NetworkOptions): URL | undefined {
    if (bypassed(target, [...(options.noProxy ?? []), ...envNoProxy()])) {
        return undefined;
    }

    const configured = options.proxy;
    if (configured !== null && configured !== undefined && configured !== "") {
        try {
            return new URL(/^[a-z]+:\/\//i.test(configured) ? configured : `http://${configured}`);
        } catch {
            log.warn("代理地址解析不了：%s", configured);
            return undefined;
        }
    }
    return envProxy(target);
}

// 环境变量里的代理。ALL_PROXY 常是 socks，这里只认 http 代理
function envProxy(target: URL): URL | undefined {
    const names =
        target.protocol === "https:"
            ? ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
            : ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

    for (const name of names) {
        const value = process.env[name]?.trim();
        if (value === undefined || value === "" || !/^https?:\/\//i.test(value)) {
            continue;
        }
        try {
            return new URL(value);
        } catch {
            // 解析不了就试下一个
        }
    }
    return undefined;
}

function envNoProxy(): readonly string[] {
    const value = process.env["NO_PROXY"] ?? process.env["no_proxy"] ?? "";
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
}

export function bypassed(target: URL, noProxy: readonly string[]): boolean {
    const host = target.hostname.toLowerCase();
    for (const entry of noProxy) {
        const trimmed = entry.trim().toLowerCase();
        if (trimmed === "") {
            continue;
        }
        if (trimmed === "*" || host === trimmed || host.endsWith(`.${trimmed}`)) {
            return true;
        }
    }
    return false;
}

function readAll(stream: Readable, limit: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > limit) {
                stream.destroy();
                reject(new Error(`响应超过 ${limit} 字节`));
                return;
            }
            chunks.push(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
