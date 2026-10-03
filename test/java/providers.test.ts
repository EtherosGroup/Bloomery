/**
 * Java 来源：Adoptium 的请求地址与响应解析，Mojang 的索引、清单解析与选择
 * @author IsCibocaz
 * @since 1.9.0
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
    adoptiumUrl,
    majorOfRuntime,
    mojangJavaPath,
    mojangPlatform,
    parseAdoptium,
    parseMojangManifest,
    pickMojangComponent,
    targetOf,
} from "../../src/java/providers.ts";

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

test("本机平台映射：索引里的平台键带架构后缀", () => {
    assert.equal(mojangPlatform("win32", "x64"), "windows-x64");
    assert.equal(mojangPlatform("win32", "arm64"), "windows-arm64");
    assert.equal(mojangPlatform("win32", "ia32"), "windows-x86");
    assert.equal(mojangPlatform("win32", "riscv64"), null);
    assert.equal(mojangPlatform("darwin", "arm64"), "mac-os-arm64");
    assert.equal(mojangPlatform("darwin", "x64"), "mac-os");
    // 索引没有 linux-arm64，linux 各架构都落到 linux，ia32 例外
    assert.equal(mojangPlatform("linux", "x64"), "linux");
    assert.equal(mojangPlatform("linux", "arm64"), "linux");
    assert.equal(mojangPlatform("linux", "ia32"), "linux-i386");
    assert.equal(mojangPlatform("freebsd", "x64"), null);
});

test("主版本号从版本名里取：jre-legacy 写作 8u202", () => {
    assert.equal(majorOfRuntime("8u202"), 8);
    assert.equal(majorOfRuntime("16.0.1.9.1"), 16);
    assert.equal(majorOfRuntime("21.0.7"), 21);
    assert.equal(majorOfRuntime("25.0.1"), 25);
    assert.equal(majorOfRuntime("x"), null);
    assert.equal(majorOfRuntime(""), null);
});

const MOJANG_INDEX = {
    linux: {
        "java-runtime-gamma": [
            {
                manifest: { url: "https://e/gamma.json", sha1: "g", size: 10 },
                version: { name: "17.0.15", released: "2025-05-19T08:24:16+00:00" },
            },
        ],
        // snapshot 发布更晚，仍要让位给非 snapshot
        "java-runtime-gamma-snapshot": [
            {
                manifest: { url: "https://e/snap.json", sha1: "s", size: 11 },
                version: { name: "17.0.15", released: "2025-06-01T00:00:00+00:00" },
            },
        ],
        "java-runtime-delta": [
            {
                manifest: { url: "https://e/delta.json", sha1: "d", size: 12 },
                version: { name: "21.0.7", released: "2025-05-19T08:30:12+00:00" },
            },
        ],
        "jre-legacy": [
            {
                manifest: { url: "https://e/legacy.json", sha1: "l", size: 13 },
                version: { name: "8u202", released: "2020-11-17T19:26:25+00:00" },
            },
        ],
        "minecraft-java-exe": [],
    },
};

test("组件选择：按主版本匹配，非 snapshot 优先", () => {
    assert.equal(pickMojangComponent(MOJANG_INDEX, "linux", 17, "t")?.name, "java-runtime-gamma");
    assert.equal(pickMojangComponent(MOJANG_INDEX, "linux", 21, "t")?.name, "java-runtime-delta");
    assert.equal(pickMojangComponent(MOJANG_INDEX, "linux", 8, "t")?.name, "jre-legacy");
    assert.equal(
        pickMojangComponent(MOJANG_INDEX, "linux", 21, "t")?.manifestUrl,
        "https://e/delta.json",
    );
    assert.equal(pickMojangComponent(MOJANG_INDEX, "linux", 22, "t"), null);
    assert.equal(pickMojangComponent(MOJANG_INDEX, "windows-x64", 21, "t"), null);
    assert.equal(pickMojangComponent({}, "linux", 21, "t"), null);
    assert.equal(pickMojangComponent(null, "linux", 21, "t"), null);
});

const MOJANG_MANIFEST = {
    files: {
        bin: { type: "directory" },
        "bin/java": {
            type: "file",
            executable: true,
            downloads: {
                raw: { url: "https://e/java", sha1: "a", size: 3 },
                lzma: { url: "https://e/java.lzma", sha1: "b", size: 1 },
            },
        },
        release: {
            type: "file",
            executable: false,
            downloads: { raw: { url: "https://e/release", sha1: "c", size: 4 } },
        },
        "legal/app/LICENSE": { type: "link", target: "../java.base/LICENSE" },
        odd: { type: "socket" },
    },
};

test("清单解析：文件取 raw，链接带 target，认不出的类型跳过", () => {
    const files = parseMojangManifest(MOJANG_MANIFEST, "t");
    assert.deepEqual(
        files.map((file) => file.path),
        ["bin", "bin/java", "release", "legal/app/LICENSE"],
    );

    const java = files[1];
    assert.equal(java?.type, "file");
    assert.equal(java?.executable, true);
    assert.equal(java?.url, "https://e/java");
    assert.equal(java?.sha1, "a");
    assert.equal(java?.size, 3);

    const release = files[2];
    assert.equal(release?.executable, false);
    assert.equal(release?.target, null);

    const link = files[3];
    assert.equal(link?.type, "link");
    assert.equal(link?.target, "../java.base/LICENSE");
    assert.equal(link?.url, null);

    assert.deepEqual(parseMojangManifest({}, "t"), []);
    assert.deepEqual(parseMojangManifest({ files: [] }, "t"), []);
});

test("java 可执行文件：macOS 在 bundle 里的 bin 下", () => {
    const files = parseMojangManifest(
        {
            files: {
                "bin/java": {
                    type: "file",
                    executable: true,
                    downloads: { raw: { url: "https://e/java", sha1: "a", size: 1 } },
                },
                "bin/java.exe": {
                    type: "file",
                    executable: true,
                    downloads: { raw: { url: "https://e/java.exe", sha1: "b", size: 1 } },
                },
            },
        },
        "t",
    );
    assert.equal(mojangJavaPath(files, "linux"), "bin/java");
    assert.equal(mojangJavaPath(files, "win32"), "bin/java.exe");
    assert.equal(mojangJavaPath([], "linux"), "bin/java");

    const mac = parseMojangManifest(
        {
            files: {
                "jre.bundle/Contents/Home/bin/java": {
                    type: "file",
                    executable: true,
                    downloads: { raw: { url: "https://e/java", sha1: "a", size: 1 } },
                },
            },
        },
        "t",
    );
    assert.equal(mojangJavaPath(mac, "darwin"), "jre.bundle/Contents/Home/bin/java");
});
