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
    | "AccountNotFound"
    | "AccountExists"
    | "AccountExpired"
    | "MicrosoftClientIdMissing"
    | "MicrosoftLoginFailed"
    | "MicrosoftNotOwned"
    | "ModNotFound"
    | "ModUnsupported"
    | "LaunchFailed";
