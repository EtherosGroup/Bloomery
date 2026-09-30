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

import type { DownloadProvider, DownloadSetting, DownloadSource } from "../config/types.ts";

const BMCLAPI = "https://bmclapi2.bangbang93.com";

export interface Source {
    readonly provider: DownloadProvider;
    readonly rewrite: (url: string) => string;
}

/** 预置下载源，加源在表里加一行 */
export interface SourcePreset {
    readonly name: string;
    readonly provider: DownloadProvider;
    readonly label: string;
}

export const SOURCE_PRESETS: readonly SourcePreset[] = [
    { name: "official", provider: "official", label: "Mojang 官方" },
    { name: "bmclapi", provider: "bmclapi", label: "BMCLAPI" },
    { name: "custom", provider: "custom", label: "自定义地址" },
];

export function presetOf(name: string): SourcePreset | undefined {
    const wanted = name.trim().toLowerCase();
    return SOURCE_PRESETS.find((item) => item.name === wanted);
}

// custom 要地址；其余用内置地址
export function sourceOf(name: string, url?: string | null): DownloadSource | undefined {
    const preset = presetOf(name);
    if (preset === undefined) {
        return undefined;
    }
    if (preset.provider === "custom") {
        const base = (url ?? "").trim().replace(/\/+$/, "");
        return base === "" ? undefined : { provider: "custom", enabled: true, url: base };
    }
    return { provider: preset.provider, enabled: true, url: null };
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
