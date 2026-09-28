/**
 * 测试用的临时 HTTP 服务与 ZIP 构造
 * @author IsCibocaz
 * @since 1.0.0
 */

import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

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
    readonly hits: ReadonlyMap<string, number>;
    readonly seen: readonly TestRequest[];
    close(): Promise<void>;
}

export async function serve(handler: (request: TestRequest) => TestRoute): Promise<TestServer> {
    const hits = new Map<string, number>();
    const seen: TestRequest[] = [];

    const server = createServer((request, response) => {
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
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    return {
        url: `http://127.0.0.1:${port}`,
        hits,
        seen,
        close: () =>
            new Promise((resolve, reject) => {
                server.closeAllConnections();
                server.close((error) => (error === undefined ? resolve() : reject(error)));
            }),
    };
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
