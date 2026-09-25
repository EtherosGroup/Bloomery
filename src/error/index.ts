/**
 * 统一错误处理层
 * @author IsCibocaz
 * @since 1.0.0
 */
export { AppError, type ErrorContext } from "./error.ts";
export type { ErrorCode } from "./codes.ts";
export { handleError } from "./handler.ts";
