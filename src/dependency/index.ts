/**
 * 依赖层
 * 处理版本 json 里的 libraries 与 assets，只算路径与规则，不做下载
 * @author IsCibocaz
 * @since 1.0.0
 */
export { allows, platformContext, type RuleContext } from "./rules.ts";
export { classpathOf, type Classpath } from "./classpath.ts";
export {
    classifierMatches,
    isClasspathLibrary,
    libraryFile,
    libraryPath,
    libraryUrlPath,
    parseCoordinate,
    type Coordinate,
} from "./library.ts";
export {
    assetIndexFile,
    assetObjectFile,
    countAssets,
    readAssetIndex,
    type AssetIndex,
    type AssetObject,
    type AssetStat,
} from "./asset.ts";
export {
    extractNatives,
    nativeClassifierOf,
    nativeJars,
    nativesLayout,
    type NativeJar,
    type NativeSelection,
    type NativesLayout,
} from "./native.ts";
