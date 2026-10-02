/**
 * 文件夹视图的渲染
 *
 * 终端给人看，--json 给脚本看，两种都从同一份视图出
 * @author IsCibocaz
 * @since 1.0.0
 */

import { loadSetting } from "../../config/index.ts";
import { print, renderTable, versioned } from "../../output/index.ts";
import { probeJava } from "../../launch/java.ts";
import type {
    FolderSummary,
    FolderView,
    InstanceState,
    InstanceView,
} from "../../version/index.ts";
import { officialJavaOf } from "../java-choice.ts";
import type { Context } from "../parse.ts";

const STATE: Record<InstanceState, string> = {
    ready: "可用",
    missing: "缺失",
    broken: "读不出来",
    incomplete: "继承不全",
};

export interface FolderListRow extends FolderSummary {
    readonly selected: boolean;
}

export interface ResolvedJava {
    readonly major: number;
    readonly path: string;
}

// list 只列保存过的文件夹，不展开里面的版本
export function printFolderList(rows: readonly FolderListRow[], ctx: Context): void {
    if (ctx.json) {
        print(JSON.stringify(rows, null, 4));
        return;
    }
    if (rows.length === 0) {
        print("还没有添加游戏文件夹，运行 bloomery folder add <路径>");
        return;
    }

    const table = rows.map((row) => [
        row.name,
        row.path,
        String(row.instanceCount),
        row.selected ? "是" : "",
        folderState(row),
    ]);
    print(
        [
            `已保存 ${rows.length} 个游戏文件夹`,
            ...renderTable(table, {
                indent: "  ",
                right: [2],
                header: ["标识", "路径", "实例", "当前", "状态"],
            }),
        ].join("\n"),
    );
}

function folderState(row: FolderListRow): string {
    return row.exists ? (row.writable ? "可写" : "只读") : "目录不存在";
}

export function printFolder(view: FolderView, ctx: Context, selected?: string | null): void {
    if (ctx.json) {
        print(JSON.stringify(versioned(folderJson(view, selected) as object), null, 4));
        return;
    }
    print(folderText(view, selected));
}

export function folderText(view: FolderView, selected?: string | null): string {
    const lines = [`${view.name}  ${view.path}`];
    if (!view.exists) {
        lines.push("  目录不存在");
    } else if (view.instances.length === 0) {
        lines.push("  没有扫到版本");
    }

    if (view.instances.length > 0) {
        const rows = view.instances.map((instance) => [
            instance.id,
            instance.id === selected ? "是" : "",
            instance.gameVersion ?? "-",
            loaderText(instance),
            instance.type ?? "-",
            marksOf(instance),
        ]);
        lines.push(
            ...renderTable(rows, {
                indent: "  ",
                header: ["版本", "当前", "游戏版本", "加载器", "类型", "备注"],
            }),
        );
    }

    if (view.dropped.length > 0) {
        lines.push(`  清单里失效的：${view.dropped.join(", ")}`);
    }
    return lines.join("\n");
}

export function folderJson(view: FolderView, selected?: string | null): unknown {
    return {
        id: view.id,
        selectedInstance: selected ?? null,
        name: view.name,
        path: view.path,
        exists: view.exists,
        writable: view.writable,
        versionsDirectory: view.versionsDirectory,
        dropped: view.dropped,
        instances: view.instances.map(instanceJson),
    };
}

export function instanceJson(instance: InstanceView): unknown {
    return {
        id: instance.id,
        name: instance.name,
        target: instance.target,
        gameVersion: instance.gameVersion,
        loader: instance.loader,
        state: instance.state,
        type: instance.type,
        directory: instance.directory,
        chain: instance.chain,
        configured: instance.configured,
        discovered: instance.discovered,
        problem: instance.problem,
        lastPlayed: instance.lastPlayedAt ?? null,
        java: {
            required: { major: instance.descriptor?.javaVersion?.majorVersion ?? 0 },
            // 列表不扫盘，解析结果只在 version info 里给
            resolved: null,
        },
    };
}

// 清单里的一行后面的标记
function marksOf(instance: InstanceView): string {
    const marks: string[] = [];
    if (instance.discovered) {
        marks.push("磁盘发现");
    }
    if (instance.state !== "ready") {
        marks.push(STATE[instance.state]);
    }
    return marks.length === 0 ? "" : `[${marks.join(" ")}]`;
}

export function loaderText(instance: InstanceView): string {
    const { type, version } = instance.loader;
    if (type === "vanilla") {
        return "原版";
    }
    return version === null || version === undefined ? type : `${type} ${version}`;
}

// 详情才扫盘：设置里的登记项与探测结果一起按要求主版本挑，再探出实际主版本
export async function resolvedJavaOf(instance: InstanceView): Promise<ResolvedJava | null> {
    const setting = await loadSetting();
    const required = instance.descriptor?.javaVersion?.majorVersion ?? null;
    const path = await officialJavaOf(setting.java, required);
    if (path === undefined) {
        return null;
    }
    const info = await probeJava(path);
    if (info === null || info.major === null) {
        return null;
    }
    return { major: info.major, path };
}

export async function printInstance(
    folderPath: string,
    instance: InstanceView,
    ctx: Context,
): Promise<void> {
    const resolved = await resolvedJavaOf(instance);
    if (ctx.json) {
        print(
            JSON.stringify(
                versioned(instanceDetail(folderPath, instance, resolved) as object),
                null,
                4,
            ),
        );
        return;
    }
    print(instanceDetailText(folderPath, instance, resolved));
}

export function instanceDetail(
    folderPath: string,
    instance: InstanceView,
    resolved: ResolvedJava | null = null,
): unknown {
    const detail = instanceJson(instance) as {
        java: { required: { major: number }; resolved: ResolvedJava | null };
    };
    return {
        folder: folderPath,
        ...detail,
        java: { ...detail.java, resolved },
        descriptor: descriptorSummary(instance),
    };
}

export function instanceDetailText(
    folderPath: string,
    instance: InstanceView,
    resolved: ResolvedJava | null = null,
): string {
    const descriptor = instance.descriptor;
    const lines = [
        `${instance.id}${instance.name === instance.id ? "" : `  (${instance.name})`}`,
        `  文件夹     ${folderPath}`,
        `  目录       ${instance.directory}`,
        `  状态       ${STATE[instance.state]}`,
        `  继承       ${instance.chain.length > 0 ? instance.chain.join(" → ") : "-"}`,
        `  加载器     ${loaderText(instance)}`,
        `  类型       ${instance.type ?? "-"}`,
    ];
    if (instance.problem !== null) {
        lines.push(`  问题       ${instance.problem}`);
    }
    if (descriptor !== null) {
        lines.push(
            `  主类       ${descriptor.mainClass ?? "-"}`,
            `  客户端 jar ${descriptor.jar ?? "-"}`,
            `  资源索引   ${descriptor.assetIndex?.id ?? descriptor.assets ?? "-"}`,
            `  Java       需要 ${descriptor.javaVersion?.majorVersion ?? "-"}`,
            `             使用 ${javaUsage(resolved)}`,
            `  库         ${descriptor.libraries.length}`,
            `  参数       game ${descriptor.arguments.game.length} / jvm ${descriptor.arguments.jvm.length}`,
            `  版本 json  ${descriptor.json}`,
        );
    }
    return lines.join("\n");
}

// 实际使用的 Java：主版本与可执行文件路径
function javaUsage(resolved: ResolvedJava | null): string {
    return resolved === null ? "-" : `${resolved.major}  ${resolved.path}`;
}

// 合并后的摘要，原始 json 太长不直接给
function descriptorSummary(instance: InstanceView): unknown {
    const descriptor = instance.descriptor;
    if (descriptor === null) {
        return null;
    }
    return {
        id: descriptor.id,
        type: descriptor.type,
        mainClass: descriptor.mainClass,
        jar: descriptor.jar,
        assets: descriptor.assets,
        assetIndex: descriptor.assetIndex?.id ?? null,
        javaVersion: descriptor.javaVersion?.majorVersion ?? null,
        libraries: descriptor.libraries.length,
        natives: descriptor.libraries.filter((library) => Object.keys(library.natives).length > 0)
            .length,
        downloads: Object.keys(descriptor.downloads),
        arguments: {
            game: descriptor.arguments.game.length,
            jvm: descriptor.arguments.jvm.length,
        },
        minecraftArguments: descriptor.minecraftArguments !== null,
        json: descriptor.json,
    };
}
