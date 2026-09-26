#!/usr/bin/env node
import { run } from "./cli/index.ts";
import { handleError } from "./error/index.ts";
import { addFileSink, flush } from "./output/index.ts";

const file = addFileSink();

async function main(): Promise<void> {
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
        await file.close();
    }
}

await main();
