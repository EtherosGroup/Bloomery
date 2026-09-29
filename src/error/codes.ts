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
    | "VersionExists"
    | "JavaNotFound"
    | "JavaBroken"
    | "JavaDuplicate"
    | "DependencyMissing"
    | "DownloadFailed"
    | "AccountNotFound"
    | "AccountExists"
    | "AccountExpired"
    | "LaunchFailed";
