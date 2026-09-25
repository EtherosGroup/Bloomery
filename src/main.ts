import { run } from "./cli/index.ts";
import { handleError } from "./error/index.ts";
import { flush } from "./output/index.ts";

async function main(): Promise<void> {
    try {
        await run(process.argv.slice(2));
    } catch (error) {
        process.exitCode = handleError(error);
    } finally {
        // 退出前等落点写入排空，process.exit() 不会等
        await flush();
    }
}

await main();
