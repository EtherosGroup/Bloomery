#!/usr/bin/env node
import { run } from "./cli/index.ts";
import { handleError } from "./error/index.ts";
import { addFileSink, flush } from "./output/index.ts";

const file = addFileSink();

async function main(): Promise<void> {
    try {
        await run(process.argv.slice(2));
    } catch (error) {
        // 没写出日志的运行不要提示路径，那个文件还不存在
        process.exitCode = handleError(error, file.opened ? file.path : undefined);
    } finally {
        // 退出前等落点写入排空，process.exit() 不会等
        await flush();
        await file.close();
    }
}

await main();
