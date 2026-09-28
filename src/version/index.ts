/**
 * 版本管理层
 * @author IsCibocaz
 * @since 1.0.0
 */
export {
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
    findInstance,
    folderIdOf,
    pickFolder,
    probeFolder,
    readFolder,
    resolveFolderPath,
    resolveGameFolder,
    sameFolderPath,
    type FolderProbe,
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
