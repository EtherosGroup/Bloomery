/**
 * 版本管理层
 * @author IsCibocaz
 * @since 1.0.0
 */
export {
    gameVersionOf,
    loaderOf,
    mergeDescriptors,
    parseDescriptor,
    readDescriptor,
    resolveDescriptor,
    type ArgumentEntry,
    type Arguments,
    type AssetIndex,
    type ConditionalArgument,
    type Descriptor,
    type DescriptorRead,
    type DownloadEntry,
    type JavaVersion,
    type Library,
    type LibraryDownloads,
    type Logging,
    type LoggingFile,
    type Resolved,
    type Rule,
    type RuleOs,
    type VersionType,
} from "./descriptor.ts";
export {
    findFolder,
    findInstance,
    folderIdOf,
    pickFolder,
    pickInstance,
    probeFolder,
    readFolder,
    resolveFolderPath,
    resolveGameFolder,
    sameFolderPath,
    summarizeFolder,
    type FolderProbe,
    type FolderSummary,
    type FolderView,
    type InstanceState,
    type InstanceView,
} from "./folder.ts";
export { readVersion, scanVersions, type LocalVersion, type VersionScan } from "./store.ts";
export {
    installVersion,
    type InstallInput,
    type InstallProgress,
    type InstallReport,
} from "./installer.ts";
export {
    fetchManifest,
    findVersion,
    MANIFEST_URL,
    type Manifest,
    type ManifestVersion,
} from "./manifest.ts";
export {
    defaultVersionName,
    fetchLoaderProfile,
    channelOf,
    filterChannel,
    listLoaderGames,
    listLoaderVersions,
    listLoaderVersionsFor,
    parseLoaderSpec,
    resolveLoaderVersion,
    type LoaderName,
    type LoaderSpec,
    type LoaderChannel,
    type LoaderVersion,
    type Transport,
} from "./loader.ts";
