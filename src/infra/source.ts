/**
 * 下载源改写
 *
 * 版本 json 里的地址全是 Mojang 的，镜像要把它们改写到自己的域名下
 * BMCLAPI 的路径规则：piston 系保持路径、libraries 加 /maven/、resources 加 /assets/
 * 版本 json 在 BMCLAPI 上有专用入口 /version/<id>/json
 * 改不了的地址原样返回，非 Mojang 的仓库（例如 Forge 的 maven）不会被带坏
 * @author IsCibocaz
 * @since 1.0.0
 */

import type { DownloadProvider, DownloadSetting } from "../config/types.ts";

const BMCLAPI = "https://bmclapi2.bangbang93.com";

export interface Source {
    readonly provider: DownloadProvider;
    readonly rewrite: (url: string) => string;
}

export function sourcesOf(download: DownloadSetting): readonly Source[] {
    const sources: Source[] = [];

    for (const source of download.sources) {
        if (!source.enabled) {
            continue;
        }
        if (source.provider === "official") {
            sources.push({ provider: "official", rewrite: identity });
            continue;
        }
        const base = (source.url ?? (source.provider === "bmclapi" ? BMCLAPI : "")).replace(
            /\/+$/,
            "",
        );
        if (base === "") {
            continue;
        }
        sources.push({ provider: source.provider, rewrite: mirror(base) });
    }

    // 一个可用的都没有就退回官方
    if (sources.length === 0) {
        sources.push({ provider: "official", rewrite: identity });
    }
    return sources;
}

function identity(url: string): string {
    return url;
}

function mirror(base: string): (url: string) => string {
    return (url) => {
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            return url;
        }

        const path = parsed.pathname.replace(/^\//, "");
        switch (parsed.hostname) {
            case "libraries.minecraft.net":
                return `${base}/maven/${path}`;
            case "resources.download.minecraft.net":
                return `${base}/assets/${path}`;
            case "piston-meta.mojang.com": {
                const version = /^v1\/packages\/[^/]+\/(.+)\.json$/.exec(path);
                return version?.[1] === undefined
                    ? `${base}/${path}`
                    : `${base}/version/${version[1]}/json`;
            }
            case "piston-data.mojang.com":
            case "launchermeta.mojang.com":
            case "launcher.mojang.com":
                return `${base}/${path}`;
            default:
                return url;
        }
    };
}
