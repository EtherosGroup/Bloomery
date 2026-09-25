/**
 * 操作系统识别
 * @author IsCibocaz
 * @since 1.0.0
 */
export type PlatformName = "Windows" | "macOS" | "Linux";

function detectPlatform(): PlatformName {
    switch (process.platform) {
        case "win32":
            return "Windows";
        case "darwin":
            return "macOS";
        default:
            return "Linux";
    }
}

export const platform: PlatformName = detectPlatform();
