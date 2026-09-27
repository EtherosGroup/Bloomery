/**
 * 进程创建的平台差异
 * @author IsCibocaz
 * @since 1.0.0
 */

import { platform } from "./os.ts";

// Windows 上 .bat/.cmd 要经 shell 启动
export function requiresShell(executable: string): boolean {
    return platform === "Windows" && /\.(bat|cmd)$/i.test(executable);
}
