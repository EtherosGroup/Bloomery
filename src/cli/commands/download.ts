/**
 * download 命令：下载队列
 *
 * 队列是文件，worker 一次一个任务：可以前台跑 run，也可以由 --async 分离拉起
 * info 只读队列文件，worker 存活与否看 pid 锁
 * @author IsCibocaz
 * @since 1.11.0
 */

import { loadSetting } from "../../config/index.ts";
import type { DownloadSetting, Network, Setting } from "../../config/types.ts";
import {
    cancelTask,
    clearFinished,
    lockHolderOf,
    readQueue,
    retryTask,
    TaskCancelled,
    workOffQueue,
    type DownloadTask,
    type TaskControl,
    type TaskError,
    type TaskProgress,
    type TaskState,
    type WorkerOptions,
} from "../../download/index.ts";
import { AppError } from "../../error/index.ts";
import { downloadOne, type TransferOptions } from "../../infra/download.ts";
import { sourcesOf } from "../../infra/source.ts";
import { installMod } from "../../mod/index.ts";
import {
    logger,
    print,
    progressReporter,
    renderTable,
    versioned,
    type ProgressStyle,
} from "../../output/index.ts";
import type { Context, DownloadCommand } from "../parse.ts";

const log = logger("download");

const STATE_TEXT: Record<TaskState, string> = {
    pending: "等待",
    running: "进行中",
    done: "完成",
    failed: "失败",
    cancelled: "已取消",
};

export async function runDownload(command: DownloadCommand, ctx: Context): Promise<void> {
    switch (command.action) {
        case "info":
            return info(command, ctx);
        case "run":
            return run(ctx);
        case "cancel":
            return cancel(command, ctx);
        case "retry":
            return retry(command, ctx);
        case "clear":
            return clear(ctx);
    }
}

/* ---------- info ---------- */

async function info(command: DownloadCommand, ctx: Context): Promise<void> {
    const queue = await readQueue();
    const worker = await lockHolderOf();

    if (command.id !== undefined) {
        const task = queue.tasks.find((one) => one.id === command.id);
        if (task === undefined) {
            throw new AppError("download", "TaskNotFound", { context: { detail: command.id } });
        }
        if (ctx.json) {
            print(JSON.stringify(versioned({ worker, task }), null, 4));
            return;
        }
        print(taskText(task));
        print("");
        print(workerText(worker));
        return;
    }

    if (ctx.json) {
        print(JSON.stringify(versioned({ worker, tasks: queue.tasks }), null, 4));
        return;
    }
    if (queue.tasks.length === 0) {
        print("队列是空的");
        return;
    }

    const rows = queue.tasks.map((task) => [
        task.id,
        STATE_TEXT[task.state],
        task.target,
        progressText(task.progress),
    ]);
    print(
        renderTable(rows, {
            indent: "  ",
            header: ["任务", "状态", "目标", "进度"],
        }).join("\n"),
    );
    print("");
    print(workerText(worker));
}

function taskText(task: DownloadTask): string {
    const lines = [
        `  任务      ${task.id}`,
        `  类型      ${task.type}`,
        `  目标      ${task.target}`,
        `  状态      ${STATE_TEXT[task.state]}`,
        `  尝试      ${task.attempts}`,
        `  创建      ${task.created}`,
        `  开始      ${task.started ?? "-"}`,
        `  结束      ${task.finished ?? "-"}`,
        `  落点      ${task.params.modsDirectory}`,
    ];
    const progress = progressText(task.progress);
    if (progress !== "") {
        lines.push(`  进度      ${progress}`);
    }
    if (task.error !== null) {
        lines.push(`  错误      ${errorText(task.error)}`);
    }
    return lines.join("\n");
}

function progressText(progress: TaskProgress | null): string {
    if (progress === null) {
        return "";
    }
    if (progress.bytes) {
        return `${progress.stage} ${sizeText(progress.done)}/${sizeText(progress.total)}`;
    }
    return `${progress.stage} ${progress.done}/${progress.total}`;
}

function errorText(error: TaskError): string {
    const retry = error.retryable ? "可重试" : "不可重试";
    return `${error.code}：${error.message}（${error.detail}）${retry}`;
}

function workerText(worker: number | null): string {
    return worker === null ? "没有下载进程在运行" : `下载进程 pid ${worker}`;
}

function sizeText(bytes: number): string {
    return bytes >= 1024 * 1024
        ? `${(bytes / 1024 / 1024).toFixed(1)}MB`
        : `${Math.round(bytes / 1024)}KB`;
}

/* ---------- run ---------- */

async function run(ctx: Context): Promise<void> {
    const setting = await loadSetting();
    const style = ctx.progress ?? (ctx.json ? "off" : setting.appearance.progress);
    const report = await workOffQueue({ run: modRunner(setting, style) });
    log.info("队列跑完：完成 %d 失败 %d 取消 %d", report.done, report.failed, report.cancelled);

    if (ctx.json) {
        print(JSON.stringify(versioned(report), null, 4));
        return;
    }
    print(`完成 ${report.done}　失败 ${report.failed}　取消 ${report.cancelled}`);
    if (report.recovered.length > 0) {
        print(`回收上次中断的任务：${report.recovered.join(" ")}`);
    }
    for (const task of report.tasks) {
        if (task.error !== null) {
            print(`  ${task.id}  ${errorText(task.error)}`);
        }
    }
    if (report.done + report.failed + report.cancelled === 0 && report.recovered.length === 0) {
        print("队列里没有等待中的任务");
    }
}

// worker 的任务执行器：mod install 走既有安装逻辑，进度同时进队列文件与进度输出
function modRunner(setting: Setting, style: ProgressStyle): WorkerOptions["run"] {
    return async (task: DownloadTask, control: TaskControl): Promise<void> => {
        const network = transferOf(setting.network, setting.download);
        const progress = progressReporter(style, undefined, task.id);
        let done = 0;
        let total = 0;

        const report = (): void => {
            progress.update("文件", done, total, true);
            control.progress("文件", done, total, true);
        };
        const wrapped: typeof downloadOne = async (item, options, onChunk) => {
            if (await control.isCancelled()) {
                throw new TaskCancelled();
            }
            total += item.size ?? 0;
            report();
            const outcome = await downloadOne(item, options, (bytes) => {
                done += bytes;
                report();
                onChunk?.(bytes);
            });
            return outcome;
        };

        try {
            await installMod({
                query: task.params.query,
                modsDirectory: task.params.modsDirectory,
                gameVersion: task.params.gameVersion,
                loader: task.params.loader,
                withDependencies: task.params.withDependencies,
                dryRun: task.params.dryRun,
                network,
                download: wrapped,
            });
        } finally {
            progress.close();
        }
    };
}

function transferOf(network: Network, download: DownloadSetting): TransferOptions {
    return {
        timeoutMs: network.timeoutMs,
        retries: network.retries,
        proxy: network.proxy ?? null,
        noProxy: network.noProxy,
        verify: download.verify,
        concurrency: network.concurrency,
        sources: sourcesOf(download),
    };
}

/* ---------- cancel / retry / clear ---------- */

async function cancel(command: DownloadCommand, ctx: Context): Promise<void> {
    const id = requireId(command);
    const result = await cancelTask(id);
    const state = result.outcome === "cancelled" ? "cancelled" : "aborting";

    if (ctx.json) {
        print(
            JSON.stringify(versioned({ id, outcome: result.outcome, task: result.task }), null, 4),
        );
        return;
    }
    if (state === "cancelled") {
        print(`已取消 ${id}`);
        return;
    }
    print(`${id} 正在跑，已递上中止请求`);
    print("等它停下：bloomery download info");
}

async function retry(command: DownloadCommand, ctx: Context): Promise<void> {
    const id = requireId(command);
    const task = await retryTask(id);

    if (ctx.json) {
        print(JSON.stringify(versioned(task), null, 4));
        return;
    }
    print(`已重新排队 ${id}`);
    print("开跑：bloomery download run");
}

async function clear(ctx: Context): Promise<void> {
    const removed = await clearFinished();
    if (ctx.json) {
        print(JSON.stringify(versioned({ removed }), null, 4));
        return;
    }
    print(`清掉 ${removed} 条记录`);
}

function requireId(command: DownloadCommand): string {
    const id = command.id;
    if (id === undefined || id === "") {
        throw new AppError("download", "UsageError", {
            context: { detail: `download ${command.action} 要给任务 id` },
        });
    }
    return id;
}
