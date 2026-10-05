/**
 * 错误码
 * @author IsCibocaz
 * @since 1.0.0
 */
export type ErrorCode =
    | "UnknownError"
    | "UsageError"
    | "UnknownCommand"
    | "NotImplemented"
    | "ConfigTooNew"
    | "FileWriteFailed"
    | "FolderNotFound"
    | "FolderUnusable"
    | "FolderDuplicate"
    | "VersionNotFound"
    | "VersionBroken"
    | "InstallBroken"
    | "GameFilesMissing"
    | "VersionExists"
    | "JavaNotFound"
    | "JavaBroken"
    | "JavaDuplicate"
    | "DependencyMissing"
    | "DownloadFailed"
    | "TaskNotFound"
    | "WorkerBusy"
    | "AccountNotFound"
    | "AccountExists"
    | "AccountExpired"
    | "MicrosoftClientIdMissing"
    | "MicrosoftLoginFailed"
    | "MicrosoftNotOwned"
    | "ModNotFound"
    | "ModUnsupported"
    | "LaunchFailed";
