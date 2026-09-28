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

const log = logger("http");

const MAX_REDIRECTS = 5;
const MAX_BUFFER = 64 * 1024 * 1024;
const USER_AGENT = "bloomery/1.0.1";

export interface NetworkOptions {
    readonly timeoutMs: number;
    readonly retries: number;
    readonly proxy?: string | null;
    readonly noProxy?: readonly string[];
    readonly headers?: Readonly<Record<string, string>>;
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

export async function httpGet(url: string, options: NetworkOptions): Promise<HttpResponse> {
    const attempts = Math.max(0, options.retries) + 1;
    let last: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const response = await follow(url, options, 0);
            if (response.status === 429 || response.status >= 500) {
                // 不读掉的连接会一直占着
                response.stream.resume();
                throw new HttpStatusError(response.status, url);
            }
            if (response.status >= 400) {
                response.stream.resume();
                throw new HttpStatusError(response.status, url);
            }
            return response;
        } catch (error) {
            last = error;
            if (error instanceof HttpStatusError && error.status < 500 && error.status !== 429) {
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

export async function httpGetBuffer(url: string, options: NetworkOptions): Promise<Buffer> {
    const response = await httpGet(url, options);
    return readAll(response.stream, MAX_BUFFER);
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
        return follow(new URL(location, target).href, options, redirects + 1);
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
        const headers: Record<string, string> = {
            "user-agent": USER_AGENT,
            accept: "*/*",
            "accept-encoding": "identity",
            ...options.headers,
        };

        let request: ClientRequest;
        const onResponse = (response: IncomingMessage): void => {
            resolve({
                status: response.statusCode ?? 0,
                headers: response.headers,
                stream: response,
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
                    method: "GET",
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
                    method: "GET",
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
                    method: "GET",
                    headers,
                    agent: false,
                },
                onResponse,
            );
        }

        // 空闲超时：socket 上有动静就重置，大文件不会被整次请求的时限砍掉
        request.setTimeout(options.timeoutMs, () => {
            request.destroy(new Error(`请求空闲超过 ${options.timeoutMs}ms：${target.href}`));
        });
        request.on("error", reject);
        request.end();
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

// 代理只对该走的地址生效，noProxy 里的直连
function proxyFor(target: URL, options: NetworkOptions): URL | undefined {
    const configured = options.proxy;
    if (configured === null || configured === undefined || configured === "") {
        return undefined;
    }
    if (bypassed(target, options.noProxy ?? [])) {
        return undefined;
    }
    try {
        return new URL(/^[a-z]+:\/\//i.test(configured) ? configured : `http://${configured}`);
    } catch {
        log.warn("代理地址解析不了：%s", configured);
        return undefined;
    }
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
