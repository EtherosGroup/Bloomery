/**
 * 测试用的临时 HTTP 服务与 ZIP 构造
 * @author IsCibocaz
 * @since 1.0.0
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { connect, createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";

export interface TestRequest {
    readonly path: string;
    /** 该路径已命中几次，从 1 开始 */
    readonly hits: number;
    readonly headers: IncomingHttpHeaders;
}

export interface TestRoute {
    readonly status: number;
    readonly body?: Buffer | string;
    readonly headers?: Readonly<Record<string, string>>;
    /** 只发响应头就不管了，用来制造空闲 */
    readonly stall?: boolean;
}

export interface TestServer {
    readonly url: string;
    readonly port: number;
    readonly hits: ReadonlyMap<string, number>;
    readonly seen: readonly TestRequest[];
    close(): Promise<void>;
}

export interface SelfSigned {
    readonly key: string;
    readonly cert: string;
}

// 传了证书就是 https，否则 http
export async function serve(
    handler: (request: TestRequest) => TestRoute,
    tls?: SelfSigned,
): Promise<TestServer> {
    const hits = new Map<string, number>();
    const seen: TestRequest[] = [];

    const listener = (request: IncomingMessage, response: ServerResponse): void => {
        const path = request.url ?? "/";
        const count = (hits.get(path) ?? 0) + 1;
        hits.set(path, count);

        const incoming: TestRequest = { path, hits: count, headers: request.headers };
        seen.push(incoming);

        const route = handler(incoming);
        response.writeHead(route.status, route.headers ?? {});
        if (route.stall === true) {
            // 不 end，客户端只能靠空闲超时断开
            response.flushHeaders();
            return;
        }
        response.end(route.body ?? "");
    };

    const server =
        tls === undefined
            ? createServer(listener)
            : createSecureServer({ key: tls.key, cert: tls.cert }, listener);

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return {
        url: `${tls === undefined ? "http" : "https"}://127.0.0.1:${port}`,
        port,
        hits,
        seen,
        close: () =>
            new Promise((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
}

export type ProxyDecision =
    | { readonly status: number; readonly host?: undefined; readonly port?: undefined }
    | { readonly status: 200; readonly host: string; readonly port: number };

export interface TestProxy {
    readonly url: string;
    /** 收到的 CONNECT 目标，按顺序 */
    readonly connects: readonly string[];
    close(): Promise<void>;
}

// CONNECT 代理：200 把隧道接到 host:port，其余状态码原样回答
export async function serveProxy(decide: (authority: string) => ProxyDecision): Promise<TestProxy> {
    const connects: string[] = [];
    // CONNECT 交出去的 socket 不在 http 服务的连接表里，收尾得自己记着
    const open = new Set<Duplex>();
    const server = createServer();

    const track = (socket: Duplex): void => {
        open.add(socket);
        socket.on("close", () => open.delete(socket));
    };

    server.on("connect", (request, client, head) => {
        const authority = request.url ?? "";
        connects.push(authority);
        track(client);
        const decision = decide(authority);
        if (decision.status !== 200 || decision.host === undefined || decision.port === undefined) {
            client.end(`HTTP/1.1 ${decision.status} refused\r\n\r\n`);
            return;
        }

        const upstream = connect(decision.port, decision.host, () => {
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length > 0) {
                upstream.write(head);
            }
            client.pipe(upstream);
            upstream.pipe(client);
        });
        track(upstream);
        upstream.on("error", () => client.destroy());
        client.on("error", () => upstream.destroy());
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}`,
        connects,
        close: () =>
            new Promise((resolve, reject) => {
                for (const socket of open) {
                    socket.destroy();
                }
                server.closeAllConnections();
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
}

// 自签证书，openssl 不在时返回 undefined
export async function selfSigned(directory: string): Promise<SelfSigned | undefined> {
    const key = join(directory, "key.pem");
    const cert = join(directory, "cert.pem");
    try {
        await new Promise<void>((resolve, reject) => {
            execFile(
                "openssl",
                [
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-keyout",
                    key,
                    "-out",
                    cert,
                    "-days",
                    "2",
                    "-subj",
                    "/CN=localhost",
                    "-addext",
                    "subjectAltName=DNS:localhost,IP:127.0.0.1",
                ],
                (error) => (error === null ? resolve() : reject(error)),
            );
        });
    } catch {
        return undefined;
    }
    return { key: await readFile(key, "utf8"), cert: await readFile(cert, "utf8") };
}

// 占用过又放开的端口，目标直连没有应答
export async function closedPort(): Promise<number> {
    const server = createTcpServer();
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    return port;
}

// 只用 store 方式拼一个 ZIP，读取端不看 CRC 所以留 0
export function zipOf(entries: ReadonlyArray<{ name: string; data: string }>): Buffer {
    const parts: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const name = Buffer.from(entry.name, "utf8");
        const data = Buffer.from(entry.data, "utf8");

        const local = Buffer.alloc(30 + name.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);

        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);

        parts.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...parts, directory, end]);
}
