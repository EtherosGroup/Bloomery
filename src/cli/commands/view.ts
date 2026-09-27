/**
 * 文件夹视图的渲染
 *
 * 终端给人看，--json 给脚本看，两种都从同一份视图出
 * @author IsCibocaz
 * @since 1.0.0
 */

import { print } from "../../output/index.ts";
import type { FolderView, InstanceState, InstanceView } from "../../version/index.ts";
import type { Context } from "../parse.ts";

const STATE: Record<InstanceState, string> = {
    ready: "可用",
    missing: "缺失",
    broken: "读不出来",
    incomplete: "继承不全",
};

export function printFolder(view: FolderView, ctx: Context): void {
    if (ctx.json) {
        print(JSON.stringify(folderJson(view), null, 4));
        return;
    }
    print(folderText(view));
}

export function folderText(view: FolderView): string {
    const lines = [`${view.name}  ${view.path}`];
    if (!view.exists) {
        lines.push("  目录不存在");
    } else if (view.instances.length === 0) {
        lines.push("  没有扫到版本");
    }
    for (const instance of view.instances) {
        lines.push(instanceText(instance));
    }
    if (view.dropped.length > 0) {
        lines.push(`  清单里失效的：${view.dropped.join(", ")}`);
    }
    return lines.join("\n");
}

export function folderJson(view: FolderView): unknown {
    return {
        id: view.id,
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
        loader: instance.loader,
        state: instance.state,
        type: instance.type,
        directory: instance.directory,
        chain: instance.chain,
        configured: instance.configured,
        discovered: instance.discovered,
        problem: instance.problem,
    };
}

// 清单里的一行
export function instanceText(instance: InstanceView): string {
    const marks: string[] = [];
    if (instance.discovered) {
        marks.push("磁盘发现");
    }
    if (instance.state !== "ready") {
        marks.push(STATE[instance.state]);
    }
    const tail = marks.length === 0 ? "" : `  [${marks.join(" ")}]`;
    return `  ${column(instance.id, 28)}${column(loaderText(instance), 18)}${instance.type ?? "-"}${tail}`;
}

// 超过列宽时留一个空格，两列不会粘在一起
function column(text: string, width: number): string {
    return text.length >= width ? `${text} ` : text.padEnd(width);
}

export function loaderText(instance: InstanceView): string {
    const { type, version } = instance.loader;
    if (type === "vanilla") {
        return "原版";
    }
    return version === null || version === undefined ? type : `${type} ${version}`;
}

export function printInstance(folderPath: string, instance: InstanceView, ctx: Context): void {
    if (ctx.json) {
        print(JSON.stringify(instanceDetail(folderPath, instance), null, 4));
        return;
    }
    print(instanceDetailText(folderPath, instance));
}

export function instanceDetail(folderPath: string, instance: InstanceView): unknown {
    return {
        folder: folderPath,
        ...(instanceJson(instance) as object),
        descriptor: descriptorSummary(instance),
    };
}

export function instanceDetailText(folderPath: string, instance: InstanceView): string {
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
            `  Java       ${descriptor.javaVersion?.majorVersion ?? "-"}`,
            `  库         ${descriptor.libraries.length}`,
            `  参数       game ${descriptor.arguments.game.length} / jvm ${descriptor.arguments.jvm.length}`,
            `  版本 json  ${descriptor.json}`,
        );
    }
    return lines.join("\n");
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
