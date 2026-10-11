/**
 * MOD 层
 *
 * 检索走 Modrinth 公开 API，安装落到实例自己的 mods/
 * 已装列表本地扫盘、按 sha1 反查；禁用就是加 .disabled 后缀
 * @author IsCibocaz
 * @since 1.1.6
 */

export {
    MODRINTH_API,
    listVersions,
    pickVersion,
    projectOf,
    projectsOf,
    searchMods,
    versionFileOfHash,
    versionOfId,
    type ModDependency,
    type ModFile,
    type ModHit,
    type ModVersion,
    type ModrinthInput,
    type SearchFilter,
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
export {
    listInstalledMods,
    scanMods,
    sha1Of,
    MOD_FILE,
    type InstalledMod,
    type ModListInput,
    type ModProjectRef,
    type ModVersionRef,
    type ScannedMod,
} from "./list.ts";
export {
    manageMods,
    type ModAction,
    type ModChange,
    type ModManageInput,
    type ModManageReport,
    type ModSkip,
    type ModSkipReason,
} from "./manage.ts";
