/**
 * 下载并解压 Java 运行时
 *
 * 只下压缩包自己解，不跑任何安装程序：Windows 是 zip，Linux/macOS 是 tar.gz
 * 包内自带一层顶层目录，剥掉之后安装根就是 <root>/<包名去后缀>，可执行位按包里的权限还原
 * @author IsCibocaz
 * @since 1.9.0
 */

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import { parseJson } from "../config/read.ts";
import { AppError } from "../error/index.ts";
import { downloadOne, fetchBuffer, type TransferOptions } from "../infra/download.ts";
import { pathExists } from "../infra/fs.ts";
import { readTar } from "../infra/tar.ts";
import { extractZip } from "../infra/zip.ts";
import { logger } from "../output/index.ts";
import {
    adoptiumUrl,
    parseAdoptium,
    targetOf,
    type JavaArtifact,
    type JavaImage,
} from "./providers.ts";

const log = logger("java");
const gunzipAsync = promisify(gunzip);

export interface JavaInstallInput {
    readonly major: number;
    readonly image: JavaImage;
    /** 安装位置：解出来的运行时放在它的下一层 */
    readonly root: string;
    readonly arch?: string | undefined;
    readonly options: TransferOptions;
    readonly dryRun?: boolean | undefined;
    readonly force?: boolean | undefined;
}

export interface JavaInstallReport {
    readonly name: string;
    readonly url: string;
    /** 安装根，例如 /opt/java/temurin-21 */
    readonly root: string;
    /** 可执行文件，登记进清单就用它 */
    readonly java: string;
    readonly archive: string;
    readonly sha256: string | null;
    readonly size: number | null;
}

export async function installJavaRuntime(input: JavaInstallInput): Promise<JavaInstallReport> {
    const target = targetOf(input.major, input.image, process.platform, input.arch);
    const api = adoptiumUrl(target);
    const artifact = parseAdoptium(
        parseJson((await fetchBuffer(api, input.options)).toString("utf8"), api),
        api,
    );
    if (artifact === null) {
        throw new AppError("java", "JavaNotFound", {
            context: {
                detail: `adoptium 没有 java ${input.major} 的 ${target.os}/${target.arch} ${target.image}`,
            },
        });
    }

    const report = reportOf(artifact, input, target.image);
    log.info(
        "java %d %s %s/%s → %s",
        input.major,
        target.image,
        target.os,
        target.arch,
        report.root,
    );
    if (input.dryRun === true) {
        return report;
    }
    if (input.force !== true && (await pathExists(report.root))) {
        throw new AppError("java", "JavaDuplicate", { context: { detail: report.root } });
    }

    await mkdir(input.root, { recursive: true });
    const archive = join(input.root, artifact.name);
    await downloadOne(
        { url: artifact.url, target: archive, sha1: null, size: artifact.size },
        input.options,
    );

    if (artifact.sha256 !== null) {
        const actual = createHash("sha256")
            .update(await readFile(archive))
            .digest("hex");
        if (actual !== artifact.sha256) {
            await rm(archive, { force: true }).catch(() => undefined);
            throw new AppError("java", "DependencyMissing", {
                context: { detail: `${artifact.name} 校验不过`, expected: artifact.sha256, actual },
            });
        }
        log.info("sha256 校验通过 %s", artifact.name);
    }

    await rm(report.root, { recursive: true, force: true });
    await unpack(archive, report.root, artifact.name);
    await rm(archive, { force: true }).catch(() => undefined);
    return report;
}

function reportOf(
    artifact: JavaArtifact,
    input: JavaInstallInput,
    image: JavaImage,
): JavaInstallReport {
    const base = artifact.name.replace(/\.(tar\.gz|zip)$/, "");
    const root = join(input.root, base);
    return {
        name: artifact.name,
        url: artifact.url,
        root,
        java: join(root, "bin", process.platform === "win32" ? "java.exe" : "java"),
        archive: join(input.root, artifact.name),
        sha256: artifact.sha256,
        size: artifact.size,
    };
}

// 包内顶层目录名就是去掉后缀的文件名
function topOf(name: string): string {
    return name.replace(/\.(tar\.gz|zip)$/, "");
}

async function unpack(archive: string, root: string, name: string): Promise<void> {
    const top = topOf(name);
    await mkdir(root, { recursive: true });

    if (name.endsWith(".zip")) {
        const written = await extractZip(archive, root, {
            strip: (entry) => (entry.startsWith(`${top}/`) ? entry.slice(top.length + 1) : entry),
        });
        log.info("解压 zip：%d 个文件", written);
        return;
    }

    const entries = readTar(await gunzipAsync(await readFile(archive)));
    let written = 0;
    for (const entry of entries) {
        if (!entry.name.startsWith(`${top}/`)) {
            continue;
        }
        const relative = entry.name.slice(top.length + 1);
        if (relative === "") {
            continue;
        }
        const target = join(root, relative);
        if (entry.directory) {
            await mkdir(target, { recursive: true });
            continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, entry.data);
        // 可执行位要还原，否则 bin/java 起不来
        await chmod(target, entry.mode & 0o777);
        written++;
    }
    log.info("解压 tar.gz：%d 个文件", written);
}
