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
    type Level,
    type LogLevel,
    type LogRecord,
    type Sink,
    setLevel,
    type Logger,
    logger,
    addSink,
    flush,
} from "./output.ts";
export { addFileSink, type FileSink, type FileSinkOptions } from "./file.ts";
