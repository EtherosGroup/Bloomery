/**
 * 官方安装器要用的 java
 *
 * 先用设置里登记的（resolveJavaFor），没登记就退回自动探测（findJava）
 * 只管挑，挑不到返回 undefined，由调用方决定怎么报错
 * @author IsCibocaz
 * @since 1.6.0
 */

import type { JavaSetting } from "../config/types.ts";
import { findJava, resolveJavaFor } from "../launch/java.ts";

export async function officialJavaOf(setting: JavaSetting): Promise<string | undefined> {
    const choice = await resolveJavaFor(setting, {}, undefined);
    if (choice !== undefined) {
        return choice.info.path;
    }
    const found = await findJava(setting);
    return found[0];
}
