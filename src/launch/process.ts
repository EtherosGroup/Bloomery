/**
 * 游戏进程
 *
 * 默认 stdio 继承父进程：游戏输出不经过日志管道，用户能在终端直接敲命令
 * 给了 logFile 就改成追加到该文件，本进程的 stdout 只留自己的输出
 * 不等游戏退出时给 unref：子进程句柄占着事件循环，本进程要等到游戏结束才退得掉
 * @author IsCibocaz
 * @since 1.0.0
 */

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";

import { AppError } from "../error/index.ts";
import { exitCodeOf } from "./exit.ts";

export interface GameProcess {
    readonly pid: number | undefined;
    /** 进程结束后给出归一化过的退出码 */
    readonly done: Promise<number>;
}

export interface GameSpawnOptions {
    /** 游戏输出追加到这个文件，省略即继承父进程 */
    readonly logFile?: string | undefined;
    /** 写进日志开头的一行；游戏一个字不输出时，这一行就是唯一的线索 */
    readonly logHeader?: string | undefined;
    /** 放开子进程句柄，本进程不等它也能退出 */
    readonly unref?: boolean | undefined;
}

export function spawnGame(
    executable: string,
    args: readonly string[],
    cwd: string,
    options: GameSpawnOptions = {},
): GameProcess {
    const child =
        options.logFile === undefined
            ? spawn(executable, [...args], { cwd, stdio: "inherit" })
            : spawnWithLog(executable, args, cwd, options.logFile, options.logHeader ?? null);

    if (options.unref === true) {
        child.unref();
    }

    const done = new Promise<number>((resolve, reject) => {
        child.on("error", (error) => {
            reject(
                new AppError("launch", "LaunchFailed", {
                    cause: error,
                    context: { detail: executable },
                }),
            );
        });
        child.on("close", (code, signal) => resolve(exitCodeOf(code, signal)));
    });

    return { pid: child.pid, done };
}

// stdout 与 stderr 共用一个追加句柄，游戏里两路输出的先后才保得住
function spawnWithLog(
    executable: string,
    args: readonly string[],
    cwd: string,
    logFile: string,
    logHeader: string | null,
): ChildProcess {
    let fd: number;
    try {
        mkdirSync(dirname(logFile), { recursive: true });
        fd = openSync(logFile, "a");
        if (logHeader !== null) {
            // 与子进程共用这个句柄，先写的话这一行一定在最前面
            writeSync(fd, logHeader);
        }
    } catch (error) {
        throw new AppError("launch", "LaunchFailed", {
            cause: error,
            context: { detail: `日志文件 ${logFile}` },
        });
    }

    try {
        return spawn(executable, [...args], { cwd, stdio: ["ignore", fd, fd] });
    } finally {
        // 子进程已经拿到自己的副本，父进程这份留着没用
        closeSync(fd);
    }
}
