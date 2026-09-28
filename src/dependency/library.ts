/**
 * 库坐标与磁盘路径
 *
 * 坐标写法 group:artifact:version[:classifier][@extension]
 * 磁盘布局沿用 Maven：libraries/<group 的点换成斜杠>/<artifact>/<version>/<artifact>-<version>[-classifier].<ext>
 * @author IsCibocaz
 * @since 1.0.0
 */

import { join, sep } from "node:path";

import { archMatches } from "../platform/index.ts";
import type { Library } from "../version/descriptor.ts";
import type { RuleContext } from "./rules.ts";

export interface Coordinate {
    readonly group: string;
    readonly artifact: string;
    readonly version: string;
    readonly classifier: string | null;
    readonly extension: string;
}

export function parseCoordinate(name: string): Coordinate | undefined {
    const parts = name.split(":");
    const group = parts[0];
    const artifact = parts[1];
    const version = parts[2];
    if (
        group === undefined ||
        artifact === undefined ||
        version === undefined ||
        group === "" ||
        artifact === "" ||
        version === ""
    ) {
        return undefined;
    }
    return {
        group,
        artifact,
        version,
        classifier: parts[3] ?? null,
        extension: parts[4] ?? "jar",
    };
}

// 库 jar 相对 libraries/ 的路径
export function libraryPath(coordinate: Coordinate): string {
    const suffix = coordinate.classifier === null ? "" : `-${coordinate.classifier}`;
    const file = `${coordinate.artifact}-${coordinate.version}${suffix}.${coordinate.extension}`;
    return join(
        coordinate.group.replace(/\./g, "/"),
        coordinate.artifact,
        coordinate.version,
        file,
    );
}

export function libraryFile(librariesRoot: string, coordinate: Coordinate): string {
    return join(librariesRoot, libraryPath(coordinate));
}

// URL 里一律用正斜杠
export function libraryUrlPath(coordinate: Coordinate): string {
    return libraryPath(coordinate).split(sep).join("/");
}

// 进 classpath 的库：不是 natives，且有 artifact 或干脆没有 downloads
export function isClasspathLibrary(library: Library): boolean {
    const coordinate = parseCoordinate(library.name);
    if (coordinate === undefined) {
        return false;
    }
    if (coordinate.classifier !== null && coordinate.classifier.startsWith("natives")) {
        return false;
    }
    if (library.downloads.artifact !== null) {
        return true;
    }
    // 没有 artifact 也没有 classifiers 的，按 Maven 标准路径找
    return Object.keys(library.downloads.classifiers).length === 0;
}

const CLASSIFIER_OS: Readonly<Record<string, string>> = {
    windows: "windows",
    linux: "linux",
    osx: "osx",
    macos: "osx",
};

// 分类名形如 linux-x86_64 或 osx-aarch_64
// 这类库在版本 json 里的 rules 只写 os.name，架构差异藏在分类名里，要按当前平台再筛一次
export function classifierMatches(classifier: string, context: RuleContext): boolean {
    const parts = classifier.split("-");
    const first = parts[0];
    const target = first === undefined ? undefined : CLASSIFIER_OS[first.toLowerCase()];
    if (target === undefined) {
        return true;
    }
    if (target !== context.osName) {
        return false;
    }
    const arch = parts[1];
    return arch === undefined || archMatches(arch, context.osArch);
}
