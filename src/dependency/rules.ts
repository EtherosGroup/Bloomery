/**
 * rules 过滤
 *
 * Mojang 的规则：从头按顺序看，命中就改成该条的动作，最后的结果为准
 * 没有 rules 视为通过；一条 rules 里的多个条件是与的关系
 * libraries 与 arguments 共用这一套
 * @author IsCibocaz
 * @since 1.0.0
 */

import {
    archMatches,
    osArch,
    osName as platformOsName,
    osVersion,
    type OsArch,
} from "../platform/index.ts";
import type { Rule } from "../version/descriptor.ts";

export interface RuleContext {
    /** windows / osx / linux */
    readonly osName: string;
    readonly osVersion: string;
    readonly osArch: OsArch | null;
    readonly features: Readonly<Record<string, boolean>>;
}

export function platformContext(features: Readonly<Record<string, boolean>> = {}): RuleContext {
    return {
        osName: platformOsName(),
        osVersion: osVersion(),
        osArch: osArch(),
        features,
    };
}

export function allows(rules: readonly Rule[] | null | undefined, context: RuleContext): boolean {
    if (rules === null || rules === undefined || rules.length === 0) {
        return true;
    }
    let allowed = false;
    for (const rule of rules) {
        if (matches(rule, context)) {
            allowed = rule.action === "allow";
        }
    }
    return allowed;
}

function matches(rule: Rule, context: RuleContext): boolean {
    const os = rule.os;
    if (os !== null) {
        if (os.name !== null && os.name !== context.osName) {
            return false;
        }
        if (os.arch !== null && !archMatches(os.arch, context.osArch)) {
            return false;
        }
        if (os.version !== null && !matchesVersion(os.version, context.osVersion)) {
            return false;
        }
    }

    const features = rule.features;
    if (features !== null) {
        for (const [key, value] of Object.entries(features)) {
            if ((context.features[key] ?? false) !== value) {
                return false;
            }
        }
    }
    return true;
}

// os.version 是正则，例如 "^10\."
function matchesVersion(pattern: string, version: string): boolean {
    try {
        return new RegExp(pattern).test(version);
    } catch {
        return false;
    }
}
