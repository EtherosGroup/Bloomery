/*
 * 宽容读取
 *
 * 配置是缓存：一个字段读错就用默认值，不让整个文件作废
 * reader 记录被读过的键，extra() 因此精确，不需要另写一份字段清单
 */

import { logger } from "../output/index.ts";

const log = logger("config");

export interface Reader {
    readonly where: string;
    string(key: string, fallback: string): string;
    nullableString(key: string, fallback: string | null): string | null;
    boolean(key: string, fallback: boolean): boolean;
    integer(key: string, fallback: number, min?: number): number;
    /** 只在写了的时候返回，用于补丁对象与三态字段 */
    optionalInteger(key: string, min?: number): number | undefined;
    optionalBoolean(key: string): boolean | undefined;
    enumeration<T extends string>(key: string, allowed: readonly T[], fallback: T): T;
    list<T>(
        key: string,
        fallback: readonly T[],
        item: (value: unknown, at: string) => T | undefined,
    ): T[];
    map<T>(
        key: string,
        fallback: Readonly<Record<string, T>>,
        item: (value: unknown, at: string) => T | undefined,
    ): Readonly<Record<string, T>>;
    object(key: string): Reader | undefined;
    /** 把这一层没读过的键收进 extras */
    extra(): void;
}

// 取对象；不是对象记一条并返回 undefined
export function object(value: unknown, where: string): Record<string, unknown> | undefined {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    if (value !== undefined) {
        log.warn("%s 不是对象，已按默认值处理", where);
    }
    return undefined;
}

// 解析 JSON；失败返回 undefined，要不要备份由调用方决定
export function parseJson(text: string, where: string): unknown {
    try {
        return JSON.parse(text);
    } catch (error) {
        log.warn("%s 解析失败：%s", where, error instanceof Error ? error.message : String(error));
        return undefined;
    }
}

export function reader(where: string, source: Record<string, unknown>, extras: string[]): Reader {
    const used = new Set<string>();
    const take = (key: string): unknown => {
        used.add(key);
        return source[key];
    };
    const wrong = (key: string, expects: string): void => {
        log.warn("%s.%s 不是%s，已按默认值处理", where, key, expects);
    };
    const asInteger = (value: unknown, key: string, min: number): number | undefined => {
        if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
            wrong(key, `不小于 ${min} 的整数`);
            return undefined;
        }
        return value;
    };

    return {
        where,

        string(key: string, fallback: string): string {
            const value = take(key);
            if (value === undefined) {
                return fallback;
            }
            if (typeof value !== "string") {
                wrong(key, "字符串");
                return fallback;
            }
            return value;
        },

        nullableString(key: string, fallback: string | null): string | null {
            const value = take(key);
            if (value === undefined) {
                return fallback;
            }
            if (value === null || typeof value === "string") {
                return value;
            }
            wrong(key, "字符串或 null");
            return fallback;
        },

        boolean(key: string, fallback: boolean): boolean {
            const value = take(key);
            if (value === undefined) {
                return fallback;
            }
            if (typeof value !== "boolean") {
                wrong(key, "布尔值");
                return fallback;
            }
            return value;
        },

        integer(key: string, fallback: number, min = 0): number {
            const value = take(key);
            return value === undefined ? fallback : (asInteger(value, key, min) ?? fallback);
        },

        optionalInteger(key: string, min = 0): number | undefined {
            const value = take(key);
            return value === undefined ? undefined : asInteger(value, key, min);
        },

        optionalBoolean(key: string): boolean | undefined {
            const value = take(key);
            if (value === undefined) {
                return undefined;
            }
            if (typeof value !== "boolean") {
                wrong(key, "布尔值");
                return undefined;
            }
            return value;
        },

        enumeration<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
            const value = take(key);
            if (value === undefined) {
                return fallback;
            }
            if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
                return value as T;
            }
            wrong(key, `以下之一（${allowed.join(" / ")}）`);
            return fallback;
        },

        list<T>(
            key: string,
            fallback: readonly T[],
            item: (value: unknown, at: string) => T | undefined,
        ): T[] {
            const value = take(key);
            if (value === undefined) {
                return [...fallback];
            }
            if (!Array.isArray(value)) {
                wrong(key, "数组");
                return [...fallback];
            }
            const read: T[] = [];
            value.forEach((entry, index) => {
                const one = item(entry, `${where}.${key}[${index}]`);
                if (one !== undefined) {
                    read.push(one);
                }
            });
            return read;
        },

        map<T>(
            key: string,
            fallback: Readonly<Record<string, T>>,
            item: (value: unknown, at: string) => T | undefined,
        ): Readonly<Record<string, T>> {
            const value = take(key);
            if (value === undefined) {
                return fallback;
            }
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                wrong(key, "对象");
                return fallback;
            }
            const read: Record<string, T> = {};
            for (const [name, entry] of Object.entries(value)) {
                const one = item(entry, `${where}.${key}.${name}`);
                if (one !== undefined) {
                    read[name] = one;
                }
            }
            return read;
        },

        object(key: string): Reader | undefined {
            const found = object(take(key), `${where}.${key}`);
            return found === undefined ? undefined : reader(`${where}.${key}`, found, extras);
        },

        extra(): void {
            for (const key of Object.keys(source)) {
                if (!used.has(key)) {
                    extras.push(`${where}.${key}`);
                }
            }
        },
    };
}
