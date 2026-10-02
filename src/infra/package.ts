/**
 * 自身元数据
 *
 * 版本只在 package.json 里写一次：发布走 npm version，其余地方都从这里取
 * @author IsCibocaz
 * @since 1.1.3
 */

import { readFileSync } from "node:fs";

let cached: string | undefined;

// 自己的版本号；读不到就 unknown
// 源码运行（node src/main.ts）时打个 dev 标记，外壳据此区分已发版与 master
export function runtimeVersion(): string {
    const base = packageVersion() ?? "0.0.0";
    return process.argv[1]?.endsWith(".ts") === true ? `${base}+dev` : base;
}

export function packageVersion(): string {
    if (cached === undefined) {
        cached = read() ?? "unknown";
    }
    return cached;
}

function read(): string | undefined {
    try {
        const text = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const version = (parsed as { version?: unknown }).version;
        return typeof version === "string" ? version : undefined;
    } catch {
        return undefined;
    }
}
