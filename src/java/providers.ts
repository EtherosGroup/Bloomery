/**
 * Java 运行时的来源
 *
 * adoptium：Eclipse Temurin 的 API，直接给压缩包地址（Linux 是 tar.gz，Windows 是 zip）
 * mojang：Mojang 的 Java 运行时清单，与游戏版本精确对应，只有 jre
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
