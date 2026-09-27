#!/usr/bin/env node
/**
 * 启动入口
 * @author IsCibocaz
 * @since 1.0.0
 */
import { run } from "./cli/index.ts";
import { flushState } from "./config/index.ts";
import { handleError } from "./error/index.ts";
import { addFileSink, flush } from "./output/index.ts";

const file = addFileSink();

export async function main(): Promise<void> {
    let failed = false;
    let failure: unknown;

    try {
        await run(process.argv.slice(2));
    } catch (error) {
        failed = true;
        failure = error;
    }

    // 记录是排队写的，先等落盘再决定日志路径要不要提示：路径必须真的存在
    // process.exit() 不会等队列，退出路径上都得靠 flush
    await flush();
    try {
        if (failed) {
            process.exitCode = handleError(failure, file.opened ? file.path : undefined);
        }
    } finally {
        // 状态没改过时是空操作
        await flushState();
        await file.close();
    }
}

await main();
