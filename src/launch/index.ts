/**
 * 起动器层
 * @author IsCibocaz
 * @since 1.0.0
 */
export {
    findJava,
    javaArchOf,
    javaEntryOf,
    javaPresent,
    javaProbeOf,
    majorOfVersion,
    parseJavaProperties,
    probeJava,
    resolveJava,
    resolveJavaExecutable,
    resolveJavaFor,
    runtimeDirectory,
    scanJava,
    type JavaChoice,
    type JavaInfo,
    type JavaScan,
} from "./java.ts";
export { accountFor, offlineUuid, type LaunchAccount } from "./account.ts";
export {
    buildGameArguments,
    buildJvmArguments,
    expandArguments,
    substitute,
    type ArgumentContext,
} from "./arguments.ts";
export { exitCodeOf } from "./exit.ts";
export {
    LAUNCHER_NAME,
    planLaunch,
    type LaunchPlan,
    type PlanInput,
    type PlanOptions,
} from "./game.ts";
export { launchOptionsOf, type LaunchOptions } from "./options.ts";
export { spawnGame, type GameProcess } from "./process.ts";
