/**
 * 输出层
 * @author IsCibocaz
 * @since 1.0.0
 */
export {
    out,
    log,
    print,
    printError,
    quiet,
    type Level,
    type LogLevel,
    type LogRecord,
    type Sink,
    setLevel,
    type Logger,
    logger,
    addSink,
    flush,
    writeOut,
} from "./output.ts";
export { addFileSink, type FileSink, type FileSinkOptions } from "./file.ts";
export {
    EXISTING_NOTE,
    PROGRESS_STAGES,
    progressReporter,
    renderBar,
    terminalIo,
    type ProgressIo,
    type ProgressKey,
    type ProgressReporter,
    type ProgressStage,
    type ProgressStyle,
} from "./progress.ts";
export { renderTable, type TableOptions } from "./table.ts";
export { displayWidth } from "./text.ts";
export { paginate, type Page } from "./page.ts";

// 对象输出的协议版本，数组输出不带
export function versioned<T extends object>(value: T): T & { v: number } {
    return { v: 1, ...value };
}

// 机器接口版本，破坏性变更才 +1；消费方按它判兼容，不按语义版本号
export const API_VERSION = 1;
