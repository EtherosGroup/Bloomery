/**
 * platform层
 * 用于统一处理，屏蔽不同操作系统之间的差异
 * @author IsCibocaz
 * @since 1.0.0
 */

export { type PlatformName, platform } from "./os.ts";
export { archMatches, osArch, osName, osVersion, type OsArch } from "./arch.ts";
export { JAVA_EXECUTABLE, JAVAC_EXECUTABLE, javaLayout, type JavaLayout } from "./java.ts";
export { requiresShell } from "./process.ts";
export {
    accountsFile,
    configDirectory,
    expandHome,
    homeDirectory,
    logDirectory,
    settingFile,
    stateFile,
} from "./path.ts";
