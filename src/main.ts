#!/usr/bin/env node
/**
 * 启动入口
 * @author IsCibocaz
 * @since 1.0.0
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// 只有直接跑这个文件才执行：main-dev.ts 会导入它，导入时不能再跑一遍
// 两侧都取 realpath，装成包后 bin 是软链
function isEntry(): boolean {
    const entry = process.argv[1];
    if (entry === undefined) {
        return false;
    }
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
}

if (isEntry()) {
    await main();
}
