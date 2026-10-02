/**
 * HTTP：直连、重定向、重试、空闲超时、自定义头、CONNECT 代理
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { bypassed, httpGet, httpGetBuffer } from "../../src/infra/http.ts";
import { closedPort, selfSigned, serve, serveProxy } from "../helpers/server.ts";

const OPTIONS = { timeoutMs: 3000, retries: 2 };

test("直连取回内容", async () => {
    const server = await serve(() => ({ status: 200, body: "你好" }));
    try {
        const buffer = await httpGetBuffer(`${server.url}/a.txt`, OPTIONS);
        assert.equal(buffer.toString("utf8"), "你好");
    } finally {
        await server.close();
    }
});

test("跟着重定向走", async () => {
    const server = await serve(({ path }) =>
        path === "/from"
            ? { status: 302, headers: { location: "/to" } }
            : { status: 200, body: "到了" },
    );
    try {
        const buffer = await httpGetBuffer(`${server.url}/from`, OPTIONS);
        assert.equal(buffer.toString("utf8"), "到了");
    } finally {
        await server.close();
    }
});

test("5xx 会重试，4xx 不会", async () => {
    const server = await serve(({ path, hits }) => {
        if (path === "/flaky") {
            return hits < 3 ? { status: 503 } : { status: 200, body: "好了" };
        }
        return { status: 404 };
    });
    try {
        assert.equal(
            (await httpGetBuffer(`${server.url}/flaky`, OPTIONS)).toString("utf8"),
            "好了",
        );
        assert.equal(server.hits.get("/flaky"), 3);

        await assert.rejects(httpGetBuffer(`${server.url}/missing`, OPTIONS));
        assert.equal(server.hits.get("/missing"), 1);
    } finally {
        await server.close();
    }
});

test("响应头与正文同一批到达时不丢字节", async () => {
    // 正文常与响应头一起到达并被缓冲，若在 response 上挂 data 监听重置超时，这一批会被冲掉
    const body = "x".repeat(5000);
    const server = await serve(() => ({ status: 200, body }));
    try {
        const buffer = await httpGetBuffer(`${server.url}/big`, OPTIONS);
        assert.equal(buffer.length, body.length);
        assert.equal(buffer.toString("utf8"), body);
    } finally {
        await server.close();
    }
});

test("空闲超时断开挂住的响应", async () => {
    const server = await serve(() => ({ status: 200, stall: true }));
    try {
        await assert.rejects(
            httpGetBuffer(`${server.url}/slow`, { timeoutMs: 200, retries: 0 }),
            (error: unknown) => /空闲|aborted|ECONNRESET|socket hang up/.test(String(error)),
        );
    } finally {
        await server.close();
    }
});

test("带上自定义请求头", async () => {
    const server = await serve(() => ({ status: 200, body: "ok" }));
    try {
        await httpGet(`${server.url}/x`, { ...OPTIONS, headers: { "x-test": "1" } });
        assert.equal(server.seen[0]?.headers["x-test"], "1");
        assert.match(String(server.seen[0]?.headers["user-agent"]), /^bloomery\//);
    } finally {
        await server.close();
    }
});

test("noProxy 的匹配", () => {
    assert.equal(bypassed(new URL("http://localhost:8080"), ["localhost"]), true);
    assert.equal(bypassed(new URL("http://a.example.com"), ["example.com"]), true);
    assert.equal(bypassed(new URL("http://a.example.com"), ["other.com"]), false);
    assert.equal(bypassed(new URL("http://a.example.com"), ["*"]), true);
    assert.equal(bypassed(new URL("http://a.example.com"), ["EXAMPLE.COM"]), true);
});

// 目标主机是假名：CONNECT 由代理转发，客户端不做 DNS
const TARGET_HOST = "manifest.bloomery.test";

test("https 配了代理就发 CONNECT，代理拒绝时报出来", async () => {
    // createConnection 挂在请求上时 Node 24 不调用它，代理会被整个跳过
    const port = await closedPort();
    const proxy = await serveProxy(() => ({ status: 502 }));
    try {
        await assert.rejects(
            httpGet(`https://${TARGET_HOST}:${port}/a.txt`, {
                ...OPTIONS,
                retries: 0,
                proxy: proxy.url,
            }),
            /代理 CONNECT 返回 502/,
        );
        assert.deepEqual([...proxy.connects], [`${TARGET_HOST}:${port}`]);
    } finally {
        await proxy.close();
    }
});

test("https 经 CONNECT 隧道取回内容", async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "bloomery-tls-"));
    try {
        const certificate = await selfSigned(directory);
        if (certificate === undefined) {
            t.skip("没有 openssl，起不了 TLS 服务");
            return;
        }
        const server = await serve(() => ({ status: 200, body: "隧道到了" }), certificate);
        const proxy = await serveProxy(() => ({
            status: 200,
            host: "127.0.0.1",
            port: server.port,
        }));
        // 自签证书不在信任库里，这一条只测隧道
        const previous = process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
        process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
        try {
            const buffer = await httpGetBuffer(`https://${TARGET_HOST}:${server.port}/tunnel`, {
                ...OPTIONS,
                proxy: proxy.url,
            });
            assert.equal(buffer.toString("utf8"), "隧道到了");
            assert.deepEqual([...proxy.connects], [`${TARGET_HOST}:${server.port}`]);
        } finally {
            if (previous === undefined) {
                delete process.env["NODE_TLS_REJECT_UNAUTHORIZED"];
            } else {
                process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = previous;
            }
            await proxy.close();
            await server.close();
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
