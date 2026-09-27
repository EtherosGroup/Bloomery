/**
 * 游戏进程
 *
 * stdio 全部继承父进程：游戏输出不经过日志管道，用户能在终端直接敲命令
 * @author IsCibocaz
 * @since 1.0.0
 */

import { spawn } from "node:child_process";

import { AppError } from "../error/index.ts";
import { exitCodeOf } from "./exit.ts";

export interface GameProcess {
    readonly pid: number | undefined;
    /** 进程结束后给出归一化过的退出码 */
    readonly done: Promise<number>;
}

export function spawnGame(executable: string, args: readonly string[], cwd: string): GameProcess {
    const child = spawn(executable, [...args], { cwd, stdio: "inherit" });

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
