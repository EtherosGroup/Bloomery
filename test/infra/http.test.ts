/**
 * HTTP：直连、重定向、重试、空闲超时、自定义头
 * @author IsCibocaz
 * @since 1.0.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { bypassed, httpGet, httpGetBuffer } from "../../src/infra/http.ts";
import { serve } from "../helpers/server.ts";

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
