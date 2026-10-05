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
    chooseInstance,
    pickFolder,
    probeFolder,
    readFolder,
    resolveFolderPath,
    resolveGameFolder,
    sameFolderPath,
    summarizeFolder,
    type FolderProbe,
    type FolderSummary,
    type FolderView,
    type InstancePick,
    type InstanceState,
    type InstanceView,
} from "./folder.ts";
export { readVersion, scanVersions, type LocalVersion, type VersionScan } from "./store.ts";
export { renameVersion, versionNameOf, type RenameInput, type RenameReport } from "./rename.ts";
export { mergeManifests, MARK_KEY, type MergeInput } from "./merge.ts";
export {
    assetIndexIdOf,
    clientJarOf,
    descriptorOf,
    firstMissing,
    missingLaunchFiles,
    missingOf,
    type InstanceFiles,
    type MissingFiles,
    type MissingInput,
    type MissingParts,
} from "./files.ts";
export {
    downloadFiles,
    fileFailures,
    installVersion,
    repairVersion,
    type DownloadFilesInput,
    type DownloadFilesReport,
    type FailureSource,
    type InstallInput,
    type InstallProgress,
    type InstallReport,
    type RepairInput,
    type RepairReport,
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
    installerUrlOf,
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
export { adoptVersion } from "./installer.ts";
export { installWithOfficial, usefulLines, type OfficialInstallReport } from "./official.ts";
