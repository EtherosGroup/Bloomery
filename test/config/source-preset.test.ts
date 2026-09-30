/**
 * 下载源预置与地址改写
 * @author IsCibocaz
 * @since 1.6.3
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    SOURCE_PRESETS,
    parseMirrorList,
    presetOf,
    sourceFor,
    sourceOf,
    sourcesOf,
} from "../../src/infra/source.ts";

test("预置名忽略大小写与空白", () => {
    assert.equal(presetOf(" BMCLAPI ")?.provider, "bmclapi");
    assert.equal(presetOf("official")?.provider, "official");
    assert.equal(presetOf("nope"), undefined);
    assert.ok(SOURCE_PRESETS.length >= 3);
});

test("生成下载源：custom 必须给地址，其余用内置", () => {
    assert.deepEqual(sourceOf("official"), { provider: "official", enabled: true, url: null });
    assert.deepEqual(sourceOf("bmclapi"), { provider: "bmclapi", enabled: true, url: null });
    assert.equal(sourceOf("custom"), undefined);
    assert.equal(sourceOf("custom", "   "), undefined);
    assert.deepEqual(sourceOf("custom", "https://mirror.example.com/"), {
        provider: "custom",
        enabled: true,
        url: "https://mirror.example.com",
    });
});

test("BMCLAPI 只改写 Mojang 主机，别的仓库原样", () => {
    const [source] = sourcesOf({
        verify: "strict",
        sources: [{ provider: "bmclapi", enabled: true, url: null }],
    });

    assert.equal(
        source?.rewrite("https://libraries.minecraft.net/org/ow2/asm/asm/9.7/asm-9.7.jar"),
        "https://bmclapi2.bangbang93.com/maven/org/ow2/asm/asm/9.7/asm-9.7.jar",
    );
    assert.equal(
        source?.rewrite("https://resources.download.minecraft.net/ab/abcd"),
        "https://bmclapi2.bangbang93.com/assets/ab/abcd",
    );
    // Forge 的 maven 不带坏
    assert.equal(
        source?.rewrite("https://maven.minecraftforge.net/net/minecraftforge/forge/x.jar"),
        "https://maven.minecraftforge.net/net/minecraftforge/forge/x.jar",
    );
});

test("一条启用的都没有时退回官方", () => {
    const list = sourcesOf({ verify: "strict", sources: [] });
    assert.equal(list.length, 1);
    assert.equal(list[0]?.provider, "official");
});

test("解析镜像站清单：数组与 entries 两种都认，坏条目跳过", () => {
    const rows = parseMirrorList(
        [
            { name: "Aaa", label: "甲", base: "https://a.example.com/" },
            { name: "bbb", url: "https://b.example.com" },
            { name: "", base: "https://c.example.com" },
            { name: "ddd" },
            "not-an-object",
        ],
        "test",
    );
    assert.deepEqual(rows, [
        { name: "aaa", label: "甲", base: "https://a.example.com" },
        { name: "bbb", label: "bbb", base: "https://b.example.com" },
    ]);

    const wrapped = parseMirrorList(
        { from: "x", entries: [{ name: "ccc", base: "https://c.example.com" }] },
        "test",
    );
    assert.equal(wrapped.length, 1);
});

test("拉来的源按 custom 写入，预置名不受清单影响", () => {
    const cached = [{ name: "zzz", label: "某镜像", base: "https://z.example.com" }];
    assert.deepEqual(sourceFor("zzz", null, cached), {
        provider: "custom",
        enabled: true,
        url: "https://z.example.com",
    });
    assert.deepEqual(sourceFor("bmclapi", null, cached)?.provider, "bmclapi");
    assert.equal(sourceFor("nope", null, cached), undefined);
});
