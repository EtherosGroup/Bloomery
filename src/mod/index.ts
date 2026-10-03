/**
 * MOD 层
 *
 * 检索走 Modrinth 公开 API，安装落到实例自己的 mods/
 * @author IsCibocaz
 * @since 1.1.6
 */

export {
    MODRINTH_API,
    listVersions,
    pickVersion,
    projectOf,
    searchMods,
    versionOfId,
    type ModDependency,
    type ModFile,
    type ModHit,
    type ModVersion,
    type ModrinthInput,
    type Transport,
    type VersionFilter,
} from "./modrinth.ts";
export {
    installMod,
    requireModTarget,
    type DependencyNote,
    type InstalledFile,
    type ModInstallInput,
    type ModInstallReport,
} from "./install.ts";
