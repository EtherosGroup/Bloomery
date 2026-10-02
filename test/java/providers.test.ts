/**
 * Java 来源：Adoptium 的请求地址与响应解析
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { adoptiumUrl, parseAdoptium, targetOf } from "../../src/java/providers.ts";

test("请求地址带上平台与包类型", () => {
    const url = adoptiumUrl({ major: 8, os: "linux", arch: "x64", image: "jre" });
    assert.match(url, /^https:\/\/api\.adoptium\.net\/v3\/assets\/latest\/8\/hotspot\?/);
    assert.match(url, /os=linux/);
    assert.match(url, /architecture=x64/);
    assert.match(url, /image_type=jre/);
});

test("本机平台映射：Windows 与 arm 的取值", () => {
    assert.deepEqual(targetOf(21, "jre", "win32", "x64"), {
        major: 21,
        os: "windows",
        arch: "x64",
        image: "jre",
    });
    assert.equal(targetOf(21, "jdk", "darwin", "arm64").os, "mac");
    assert.equal(targetOf(21, "jdk", "darwin", "arm64").arch, "aarch64");
    assert.equal(targetOf(8, "jre", "linux", "arm64").arch, "aarch64");
});

test("解析响应：取链接、文件名、sha256 与大小", () => {
    const raw = [
        {
            release_name: "jdk8u504-b01",
            binary: {
                package: {
                    name: "OpenJDK8U-jre_x64_linux_hotspot_8u504b01.tar.gz",
                    link: "https://github.com/adoptium/temurin8-binaries/releases/download/x/y.tar.gz",
                    checksum: "52dcd578baca1d3e449ea867",
                    size: 41834821,
                },
            },
        },
    ];
    const artifact = parseAdoptium(raw, "test");

    assert.equal(artifact?.provider, "adoptium");
    assert.equal(artifact?.name, "OpenJDK8U-jre_x64_linux_hotspot_8u504b01.tar.gz");
    assert.match(artifact?.url ?? "", /^https:\/\/github\.com\/adoptium\//);
    assert.equal(artifact?.sha256, "52dcd578baca1d3e449ea867");
    assert.equal(artifact?.size, 41834821);
});

test("响应不是数组或缺字段时给 null", () => {
    assert.equal(parseAdoptium([], "test"), null);
    assert.equal(parseAdoptium({}, "test"), null);
    assert.equal(parseAdoptium([{ binary: {} }], "test"), null);
    assert.equal(parseAdoptium([{ binary: { package: { name: "x" } } }], "test"), null);
});
