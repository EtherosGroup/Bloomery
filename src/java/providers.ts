/**
 * Java 运行时的来源
 *
 * adoptium：Eclipse Temurin 的 API，直接给压缩包地址（Linux 是 tar.gz，Windows 是 zip）
 * mojang：Mojang 的 Java 运行时索引，顶层是平台、平台下面是组件、组件指向一份逐文件清单
 * 索引里的平台键带架构后缀，linux 一份通吃 x64 与 arm64
 * 清单里的文件只取 downloads.raw，lzma 是压缩过的，要额外解码器
 * 各家差别只在"参数怎么翻译成请求、从响应里取哪个字段"，加一家就是一个函数
 * @author IsCibocaz
 * @since 1.9.0
 */

import { object } from "../config/read.ts";

export type JavaProvider = "adoptium" | "mojang";

export type JavaImage = "jre" | "jdk";

export interface JavaArtifact {
    readonly provider: JavaProvider;
    /** 压缩包文件名，也是解压后顶层目录的候选名 */
    readonly name: string;
    readonly url: string;
    /** adoptium 给 sha256，mojang 给 sha1 */
    readonly sha256: string | null;
    readonly size: number | null;
}

export interface JavaTarget {
    readonly major: number;
    readonly os: string;
    readonly arch: string;
    readonly image: JavaImage;
}

export function adoptiumUrl(target: JavaTarget): string {
    const params = new URLSearchParams({
        os: target.os,
        architecture: target.arch,
        image_type: target.image,
    });
    return `https://api.adoptium.net/v3/assets/latest/${target.major}/hotspot?${params.toString()}`;
}

// Adoptium 响应是数组，第一项的 binary.package 就是压缩包
export function parseAdoptium(raw: unknown, where: string): JavaArtifact | null {
    const list = Array.isArray(raw) ? raw : [];
    const first = object(list[0], `${where}[0]`);
    const binary = object(first?.["binary"], `${where}[0].binary`);
    const pack = object(binary?.["package"], `${where}[0].binary.package`);
    const url = pack?.["link"];
    const name = pack?.["name"];
    if (typeof url !== "string" || url === "" || typeof name !== "string") {
        return null;
    }
    const checksum = pack?.["checksum"];
    const size = pack?.["size"];
    return {
        provider: "adoptium",
        name,
        url,
        sha256: typeof checksum === "string" ? checksum : null,
        size: typeof size === "number" ? size : null,
    };
}

// 本机平台映射成 adoptium 的取值
export function targetOf(
    major: number,
    image: JavaImage,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): JavaTarget {
    return {
        major,
        os: platform === "win32" ? "windows" : platform === "darwin" ? "mac" : "linux",
        arch: arch === "arm64" ? "aarch64" : "x64",
        image,
    };
}

/* ---------- Mojang ---------- */

/** Mojang 的 Java 运行时索引，地址里带的是清单指纹 */
export const MOJANG_INDEX =
    "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";

/** 索引里的平台键；gamecore 没有 Java 运行时，不算安装目标 */
export type MojangPlatform =
    | "linux"
    | "linux-i386"
    | "mac-os"
    | "mac-os-arm64"
    | "windows-x64"
    | "windows-arm64"
    | "windows-x86";

export interface MojangComponent {
    /** 组件名，例如 java-runtime-delta */
    readonly name: string;
    /** version.name，例如 21.0.7 */
    readonly version: string;
    readonly released: string;
    readonly manifestUrl: string;
    readonly manifestSha1: string;
}

export interface MojangFile {
    /** 相对安装根的路径 */
    readonly path: string;
    readonly type: "file" | "directory" | "link";
    readonly executable: boolean;
    /** link 指向的目标，相对链接所在目录 */
    readonly target: string | null;
    readonly url: string | null;
    readonly sha1: string | null;
    readonly size: number | null;
}

// 本机平台映射成索引里的平台键；索引只有 linux 与 linux-i386，arm 架构的 Linux 也取 x64 那份
export function mojangPlatform(
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
): MojangPlatform | null {
    if (platform === "win32") {
        return arch === "x64"
            ? "windows-x64"
            : arch === "arm64"
              ? "windows-arm64"
              : arch === "ia32"
                ? "windows-x86"
                : null;
    }
    if (platform === "darwin") {
        return arch === "arm64" ? "mac-os-arm64" : "mac-os";
    }
    if (platform === "linux") {
        return arch === "ia32" ? "linux-i386" : "linux";
    }
    return null;
}

// 版本名的主版本号；jre-legacy 写作 8u202
export function majorOfRuntime(version: string): number | null {
    const matched = /^(\d+)/.exec(version.trim());
    const digits = matched?.[1];
    if (digits === undefined) {
        return null;
    }
    const value = Number.parseInt(digits, 10);
    return Number.isFinite(value) && value > 0 ? value : null;
}

// 索引 → 该平台该主版本的组件；非 snapshot 优先，其次按发布时刻倒序
export function pickMojangComponent(
    raw: unknown,
    platform: MojangPlatform,
    major: number,
    where: string,
): MojangComponent | null {
    const all = object(raw, where);
    const components = object(all?.[platform], `${where}.${platform}`);
    if (components === undefined) {
        return null;
    }

    const candidates: MojangComponent[] = [];
    for (const [name, value] of Object.entries(components)) {
        const at = `${where}.${platform}.${name}[0]`;
        const first = object(Array.isArray(value) ? value[0] : undefined, at);
        const version = object(first?.["version"], `${at}.version`);
        const manifest = object(first?.["manifest"], `${at}.manifest`);
        const versionName = version?.["name"];
        const url = manifest?.["url"];
        if (typeof versionName !== "string" || majorOfRuntime(versionName) !== major) {
            continue;
        }
        if (typeof url !== "string" || url === "") {
            continue;
        }
        const released = version?.["released"];
        const sha1 = manifest?.["sha1"];
        candidates.push({
            name,
            version: versionName,
            released: typeof released === "string" ? released : "",
            manifestUrl: url,
            manifestSha1: typeof sha1 === "string" ? sha1 : "",
        });
    }

    candidates.sort((left, right) => {
        const snapshot =
            Number(left.name.includes("snapshot")) - Number(right.name.includes("snapshot"));
        if (snapshot !== 0) {
            return snapshot;
        }
        const released = right.released.localeCompare(left.released);
        return released !== 0 ? released : left.name.localeCompare(right.name);
    });
    return candidates[0] ?? null;
}

// 逐文件清单 → 文件表；只认 file / directory / link 三种
export function parseMojangManifest(raw: unknown, where: string): MojangFile[] {
    const root = object(raw, where);
    const files = object(root?.["files"], `${where}.files`);
    if (files === undefined) {
        return [];
    }

    const parsed: MojangFile[] = [];
    for (const [path, value] of Object.entries(files)) {
        const at = `${where}.files.${path}`;
        const entry = object(value, at);
        if (entry === undefined) {
            continue;
        }
        const type = entry["type"];
        if (type !== "file" && type !== "directory" && type !== "link") {
            continue;
        }
        const downloads = object(entry["downloads"], `${at}.downloads`);
        const download = object(downloads?.["raw"], `${at}.downloads.raw`);
        const url = download?.["url"];
        const sha1 = download?.["sha1"];
        const size = download?.["size"];
        const target = entry["target"];
        parsed.push({
            path,
            type,
            executable: entry["executable"] === true,
            target: typeof target === "string" ? target : null,
            url: typeof url === "string" && url !== "" ? url : null,
            sha1: typeof sha1 === "string" ? sha1 : null,
            size: typeof size === "number" ? size : null,
        });
    }
    return parsed;
}

// 清单里 java 可执行文件的路径；macOS 在 jre.bundle/Contents/Home/bin 下
export function mojangJavaPath(
    files: readonly MojangFile[],
    platform: NodeJS.Platform = process.platform,
): string {
    const wanted = platform === "win32" ? /(^|\/)bin\/java\.exe$/ : /(^|\/)bin\/java$/;
    const found = files.find((file) => file.type === "file" && wanted.test(file.path));
    return found?.path ?? (platform === "win32" ? "bin/java.exe" : "bin/java");
}
