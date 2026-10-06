# Bloomery 启动器

Minecraft 启动器命令行。TypeScript 编写，Node ≥ 20，零运行时依赖。

## 安装

```bash
npm i -g bloomery
bloomery --version
```

从源码：

```bash
git clone https://github.com/EtherosGroup/Bloomery.git
cd Bloomery
npm install
npm run start -- --version
```

## 更新

```bash
npm i -g bloomery@latest
```

## 快速开始

```bash
bloomery folder add ~/.minecraft           # 登记游戏文件夹
bloomery java scan                         # 扫描本机 Java
bloomery auth login cibocaz                # 离线账户
bloomery install 1.20.6                    # 安装原版
bloomery install 1.20.6 --loader fabric    # 安装加载器版本
bloomery launch                            # 启动
```

`install` 的输出末行给出该实例的启动命令，直接复制即可。

## 命令

```
bloomery [全局选项] <命令> [命令选项] [参数]
```

### launch

启动游戏。省略版本时按序取：当前选中 → 上次启动 → 第一个可用。

启动前先查启动文件，缺的走 install 那四类通道补回来，补不齐不起进程。检查覆盖客户端 jar、库、natives 与资源：索引在本地时按索引数缺几个对象，索引整份不在而版本 json 给了地址时连索引一起下，待下载大小取版本 json 的 `totalSize` 与索引自身。

```bash
bloomery launch                            # 启动默认实例，缺文件先补
bloomery launch 1.20.6-fabric-0.19.5       # 指定实例 id
bloomery launch --repair                   # 只检查与补全，不启动
bloomery launch --dry-run                  # 只打印启动计划，缺件数写在计划里
bloomery launch --account cibocaz          # 指定账户
bloomery launch --folder mc                # 指定文件夹
bloomery launch --detach                   # 起完就返回，不等游戏退出
bloomery launch --wait-for-exit            # 等游戏退出，退出码原样带出去
bloomery launch --memory 4096              # 本次启动的内存上限，不写进配置
```

等不等游戏退出由 `setting.json` 的 `launch.waitForExit` 决定，默认等。命令行给了 `--wait-for-exit` 或 `--detach` 时以命令行为准，两个同时给报 `UsageError`。不等时退出码拿不到。

游戏输出的去向按调用方式分两种：`--json` 与 `--detach` 下追加到 `<日志目录>/instance-<实例 id>.log`，结果里的 `log` 给这个路径 —— 游戏占住 stdout 会破坏 `--json` 的正文，也会让 `--detach` 的调用方等到游戏结束才拿到管道 EOF；其余情况继承终端，实时可见。结果里的 `pid` 是游戏进程号，`--dry-run` 时为 `null`；`--detach` 之后本进程随即退出，消费方按 `pid` 认这个实例在不在跑。

`--memory <mb>` 覆盖本次启动的内存上限，压过实例、文件夹与全局三层，小于生效的 `minMb` 时报 `UsageError`；要持久化改内存用 `config set launch.memory.maxMb`。

启动当前选中实例时，首行给出提示。`--dry-run` 不改动磁盘，`--repair` 不改启动统计（`state.json` 的启动次数与上次游玩时间只在真的启动时更新）。两个一起给时以 `--dry-run` 为准。索引整份不在时 `--dry-run` 给一行「资源 索引缺失，需下载索引与全部资源约 X MB」，数字来自版本 json。补全走进度事件，`--progress ndjson` 下与 `install` 同一套阶段名。下载失败报 `DependencyMissing`（可重试），sha1 校验不过报 `InstallBroken`（不可重试）。

### install

安装指定版本。目录名默认按版本与加载器推导。

```bash
bloomery install 1.20.6                          # 原版
bloomery install 1.20.6 --loader fabric          # 最新 fabric
bloomery install 1.20.6 --loader fabric@0.19.5   # 指定加载器版本
bloomery install 1.20.6 --loader quilt
bloomery install 1.20.6 --loader forge           # 官方安装器，取最新正式版
bloomery install 1.20.6 --loader forge@50.2.10   # 指定 Forge 版本，游戏版本前缀可省
bloomery install 1.20.6 --loader neoforge        # neoforge 版本号不带游戏版本前缀
bloomery install 1.20.6 --loader neoforge@20.6.141
bloomery install 1.20.6 --name MyPack            # 指定实例名
bloomery install 1.20.6 --no-assets              # 跳过资源对象
```

同名实例已存在时拒绝，不覆盖。

四种加载器装出来都是**一个自包含实例**：安装时把原版与加载器两层合并成一份 json，删掉 `inheritsFrom` 与 `jar`，`id` 用实例名，客户端 jar 放在实例目录里，`versions/` 下不会多出原版目录。库与资源仍走共享的 `<游戏文件夹>/libraries` 与 `assets`。合并后的 json 带一个 `bloomery` 标记键，记录游戏版本与加载器 —— `inheritsFrom` 不在之后，那是认这两样的唯一依据（`version list` 的游戏版本、MOD 的游戏版本过滤都靠它）。

forge 与 neoforge 走官方安装器，装的时候基础版本要短暂存在（安装器与挑 Java 都要它）：装完把基础版本的客户端 jar 挪进实例目录，再把这份临时目录删掉。**用户本来就有的基础版本不动** —— 别的实例可能还在引用它。

`install --json` 的 `base` 字段说明安装过程中基础版本是复用现成的还是这次临时装的（`present` / `installed`；临时装的那份已并入实例，不再单独保留），只有 forge 与 neoforge 会用到；fabric 与 quilt 恒为 `none`。

### auth

账户管理。离线账户立即可用，微软账户见下文。

```bash
bloomery auth login cibocaz                      # 离线账户
bloomery auth login --type microsoft             # 微软设备码登录
bloomery auth list
bloomery auth use cibocaz                        # 切换当前账户，不登录
bloomery auth use cibocaz --type microsoft
bloomery auth logout cibocaz
```

离线账户立即可用。`auth login --type microsoft --json` 的 stdout 是 NDJSON 事件流，见[设备码登录流](#设备码登录流)。

`auth use <游戏名>` 只改 `setting.json` 的当前账户，不登录、不联网、不碰凭据；重名判定与 `logout` 同一套。

`auth logout <游戏名>` 不给 `--type` 时按游戏名在全部账户里找；同名有多条（离线与微软各一条）时报用法错误，detail 列出匹配到的类型。给了 `--type` 就按 `<游戏名>@<类型>` 认。

### mod

从 Modrinth 检索与安装 MOD。

```bash
bloomery mod search sodium                       # 检索
bloomery mod search sodium --limit 20
bloomery mod install sodium                      # 装进实例的 mods/
bloomery mod install sodium --version 1.20.6-fabric
bloomery mod install sodium-extra --deps         # 连必需依赖
bloomery mod install sodium --no-deps
bloomery mod install sodium --dry-run            # 只算不装
bloomery mod install sodium --async              # 入队并后台下载，立刻返回
```

目标实例省略时同 `launch` 的规则。文件落在该实例自己的 `mods/` 下，同名文件已存在时跳过。目前只接 Modrinth。

`--async` 把任务写进下载队列后立刻返回，目标实例与落点在入队时定死；装不上的实例（非加载器版本、认不出游戏版本）当场报错，不入队。入队之后分离拉起一个后台 worker 接着下载：进程 detach 加 unref，父命令退出与终端 Ctrl+C 不影响子进程；子进程的 stdout 与 stderr 追加到 `<日志目录>/worker.log`，每次拉起写一行抬头。已有存活 worker 时不再拉起，新任务由它接走（每跑完一个任务重读队列）。入口不可用或进程创建失败时任务留在队列里，用 `download run` 手动跑。`BLOOMERY_NO_WORKER=1` 时只入队。

### download

下载队列：装 MOD 这类活可以排到后台按顺序跑。

```bash
bloomery download info                           # 队列总览：任务 / 状态 / 目标 / 进度
bloomery download info 0f3a1b2c                  # 单个任务详情，失败时给错误码与 detail
bloomery download run                            # 处理等待中的任务，跑完退出
bloomery download cancel 0f3a1b2c                # 等待中的直接标记，跑着的递中止请求
bloomery download retry 0f3a1b2c                 # 失败的重新排队
bloomery download clear                          # 清掉已完成与已取消的记录
```

队列是文件不是服务：任务清单在 `<数据目录>/downloads.json`，worker 一次一个任务，可以前台跑 `download run`，也可以由 `mod install --async` 分离拉起。`info` 只读队列文件，是否真有 worker 在跑看 pid 锁（`downloads.lock`），所以「卡住」与「在跑」不会混。已有 worker 在跑时再起 `download run` 会被拒绝；上次没跑完的任务下次启动时标为失败，重跑由 `download retry` 决定。后台 worker 的正文落在 `<日志目录>/worker.log`（追加写，每次拉起一行抬头），队列与进程的实况看 `download info`。

进度写盘节流（状态变化必写，进度最多每秒一次）；跑 `download run` 时加 `--progress ndjson` 能把实时进度流到 stderr，事件里带 `taskId`。

### modpack

导入 Modrinth 的 `.mrpack`。

```bash
bloomery modpack pack.mrpack
bloomery modpack pack.mrpack --name MyPack       # 实例名
bloomery modpack pack.mrpack --dry-run           # 只算不导入
bloomery modpack pack.mrpack --no-assets
```

按包里的游戏版本与加载器建实例，随后下清单文件（校验 sha1）、摊平 `overrides/` 与 `client-overrides/`。清单里没有下载地址的文件只记警告，不中止。

### view

加载器与游戏版本互相查询。

```bash
bloomery view loader                             # 四种加载器概览
bloomery view loader fabric                      # 某加载器的全部版本，每页 20 条
bloomery view loader fabric --page 2
bloomery view loader neoforge --type release     # 只看正式版
bloomery view loader fabric --game 1.20.6        # 该游戏版本上可用的加载器版本
bloomery view loader fabric --games              # 该加载器支持的游戏版本
bloomery view game 1.20.6                        # 该游戏版本上四种加载器各有哪些版本
```

发布通道由版本号判断：含 `alpha` 为预览，含 `beta` / `rc` / `pre` / `snapshot` 为测试，其余为正式。

### version

```bash
bloomery version list                            # 列出实例，标出当前选中
bloomery version info 1.20.6-fabric-0.19.5       # 单个实例详情
bloomery version select 1.20.6-fabric-0.19.5     # 选中
bloomery version rename 1.20.6 vanilla           # 改实例名
bloomery version rename 1.20.6 vanilla --dry-run # 只算不改
```

选中后 `launch` 与 `mod install` 省略版本时都用它。优先级：命令行给的 > 当前选中 > 上次启动 > 第一个可用。

`version info` 的实例 JSON 带 `java{required,resolved}`：`required` 是版本 json 要求的主版本，`resolved` 是按启动同一条规则挑出的实际 Java（主版本与可执行文件路径），挑不到时为 `null`。`lastPlayed` 是上次启动时刻，没启动过时为 `null`。

`version rename <旧名> <新名>` 把实例目录整份改名，并同步四处引用：

- `<versions>/<旧名>/` → `<versions>/<新名>/`，目录里的 `<旧名>.json` 与 `<旧名>.jar` 跟着改名（json 里的 `id` 是游戏版本号，不动）
- 同一文件夹里其它版本的 `inheritsFrom` 或 `jar` 指向旧名的，一并改写；返回的 `rewritten` 列出这些实例 id
- `setting.json`：该实例配置项的 `id`、别的实例配置项的 `target`、`selectedInstance`
- `state.json`：统计键 `<文件夹 id>/<旧名>` 与 `lastInstance`

新名字去首尾空白，不得为空、不得含 `/` `\` `<>:"|?*` 与控制字符；与旧名相同直接成功返回（`moved: false`）；新名已存在报 `VersionExists`；旧名不在报 `VersionNotFound`。省略 `--folder` 时按当前文件夹。

### folder

```bash
bloomery folder add ~/.minecraft                 # 登记，并设为当前
bloomery folder add ~/.minecraft --dry-run       # 只校验并扫描，不落盘、不改当前
bloomery folder add ~/.minecraft --no-select     # 登记，但不设为当前
bloomery folder list
bloomery folder scan                             # 扫描全部已登记文件夹上已有的版本
bloomery folder scan mc                          # 只扫描某一条，参数是标识不是路径
bloomery folder select mc                        # 切换当前文件夹
bloomery folder remove mc
```

`scan` 纯只读，不写配置。`remove` 只把这条从配置里摘掉，不删磁盘上的任何文件。

### java

```bash
bloomery java scan                               # 扫描本机并写回清单
bloomery java list
bloomery java add /usr/lib/jvm/jdk-21/bin/java
bloomery java which                              # 当前会挑中哪个 Java
bloomery java which --major 21                   # 只看主版本 21
bloomery java remove /path/to/java
bloomery java install 21                         # 下压缩包解压并登记
bloomery java install 21 --image jdk --arch x64 --path /opt/java
bloomery java install 21 --dry-run               # 只查地址，不下载
bloomery java install 21 --provider mojang       # 换 Mojang 官方运行时，按清单逐文件下载
bloomery java install 21 --provider mojang --dry-run   # 预览组件、平台、文件数与总大小
```

`java install <主版本>` 从 Adoptium 下压缩包就地解压，不运行安装程序；校验 sha256，装完自动登记（`--no-register` 关掉，目标已存在时 `--force` 重装）。`java remove` 只改配置，不删磁盘上的 Java 目录。

`--provider mojang` 改用 Mojang 的 Java 运行时索引：按 `version.name` 的主版本挑组件（非 snapshot 优先），按该平台的逐文件清单并发下载并逐个校验 sha1，按 `executable` 还原可执行位、按 `link` 还原符号链接；清单本身也对照索引里的 sha1 校验。Mojang 只发 jre 组件，`--image jdk` 报用法错误。安装根是 `<path>/<组件名>-<版本>`。

`--major` 只对 `java which` 生效，`java list` 列出清单里的全部条目。

### mirror

查看、切换下载源，或从镜像站拉取清单。默认 Mojang 官方直连。

```bash
bloomery mirror list                             # 预置源、拉来的源与当前选择
bloomery mirror use bmclapi                      # 切到 BMCLAPI
bloomery mirror use official                     # 切回官方
bloomery mirror use custom --url https://mirror.example.com
bloomery mirror update --from https://example.com/mirrors.json
bloomery mirror update                           # 不给 --from 就用上次的地址
```

`update` 拉取的清单格式（数组，或 `{ "entries": [...] }`）：

```json
[{ "name": "bmclapi", "label": "BMCLAPI", "base": "https://bmclapi2.bangbang93.com" }]
```

拉来的清单缓存在 `<配置目录>/mirrors.json`（含来源地址与拉取时刻），`mirror use <名字>` 对预置与拉来的源一视同仁；拉来的源按 `custom` 写入。BMCLAPI 只改写 Mojang 主机（库、资源、版本 json），Forge 等第三方 maven 原样直连。写入的是 `setting.json` 的 `download.sources`。

### config

读写 `setting.json`。全局键是点分路径（与 `defaults.ts` 的默认值一致）；文件夹与实例级的键用 `--folder <id>` / `--folder <id> --instance <id>` 定位，键相对该作用域。

```bash
bloomery config get                                    # 整份配置
bloomery config get network.concurrency                # 全局单键
bloomery config set network.concurrency 16             # 值按 JSON 字面量认
bloomery config set launch.jvmArgs '["-XX:+UseG1GC"]'  # 数组整体替换
bloomery config set network.proxy null                 # 清空可空字段
bloomery config set network.proxy 8080 --string        # 强制当字符串
bloomery config unset network.concurrency              # 回默认值
bloomery config set memory.maxMb 2048 --folder mc      # 文件夹级覆盖
bloomery config set memory.maxMb 3072 --folder mc --instance '1.20.1-农夫'
bloomery config get --folder mc --instance '1.20.1-农夫' # 该实例整条配置
```

- **`--folder` / `--instance` 取的是 id 本身，不按点号切分**，所以含点号的实例 id（`1.20.1-农夫`、`1.18.2-Forge_40.3.0`）只能走这条路
- 点分写法对 id 里没有 `.` 的情形仍然可用（`folders.mc.instances.1.20.6.memory.maxMb`）；id 里有点号时点分寻址报 `UsageError`，detail 里给出改用 flag 的提示
- `--instance` 必须配 `--folder`：实例 id 只在文件夹内唯一；两者与 `folders.` 开头的键不能同时给
- 文件夹级可写 `name` / `java` / `memory.minMb` / `memory.maxMb`；实例级可写 `name` / `java` / `notes` / `memory.*` / `window.*` / `jvmArgs` / `gameArgs` / `useGlobalSettings.*`
- 值先按 JSON 字面量认（`true` / `false` / `null` / 数字 / `[...]` / `{...}`），认不出当普通字符串；`--string` 直接当字符串
- 类型与键都对不上时报 `UsageError`；枚举键的取值写在 detail 里
- `unset` 对全局键恢复默认值，对文件夹与实例的键删掉这一项，补丁删空时置 `null`
- 配置里还没有那条实例时，`set` 按磁盘上扫到的版本补一条配置项，内存与窗口的覆盖才有地方落
- 由别的命令维护的键在这里读写都报 `UsageError` 并指出入口：`selectedAccount`（`auth`）、`selectedFolder`（`folder select`）、`selectedInstance`（`version select`）、`java.list`（`java add` / `remove` / `scan`）、`download.sources`（`mirror use`）
- 写盘与其余命令同一套：临时文件 + rename

`--json` 的输出里 `key` 是作用域内的键，文件夹与实例另给字段，含点号的 id 才不会歧义：

```json
{ "v": 1, "key": "memory.maxMb", "folder": "mc", "instance": "1.20.1-农夫", "value": 3072 }
```

### status

一次拿全外壳要的环境事实。只读：不写 `setting.json`，也不写 `state.json` 的探测缓存；清单里的 Java 逐个真探测。

```bash
bloomery status            # 人看的几行
bloomery --json status     # 机器形状见下表
```

`features` 是本进程实际支持的能力键（`downloadQueue` / `launchRepair` / `modAsync` / `progressKey`），外壳据此显示入口，不拿版本号猜。`javaDefault` 是启动会用的那个 Java，取不到时为 `null`，有值时恒等于某个 `java[].path`。`folder` 为 `null` 表示没有可用的游戏文件夹；其上的 `selected` 恒为 `true`（它本来就是当前生效的那个），`selectedInstance` 是实例 id。`memory.currentMb` 是选中实例生效的上限，无选中实例时为 `null`；`globalMb` 恒有值，给设置页滑块。首次运行没有 `setting.json` 时 `mirror.source` 为 `null`，此时生效值都还是默认值。

### 全局选项

```
-v, --verbose     输出调试日志
-q, --quiet       只输出警告与错误
    --json        以 JSON 输出结果
    --progress <style>  进度输出：bar / plain / off / ndjson
    --home <dir>  指定数据目录
-h, --help        显示帮助
-V, --version     显示版本号
```

全局选项必须写在命令名之前：`bloomery --json install 1.20.6`。写在命令名之后按未知选项报 `UsageError`，`--json` 下仍给错误信封：

```bash
bloomery --json install 1.20.6      # 对
bloomery install 1.20.6 --json      # UsageError：全局选项 --json 要写在命令名之前
```

`--version` 输出单个 token。从源码运行（`node src/main.ts`）时带 `+dev` 后缀，安装版不带。

`--home <dir>` 指定数据目录，`setting.json` / `accounts.json` / `state.json` / `mirrors.json` 与日志都跟着走，日志落在 `<dir>/.config/bloomery/logs`。落点目录在第一条日志写入时才取，那时 `--home` 已经生效。

`--json` 下标准输出只有一份 JSON，过程提示静默；出错时标准输出给一份机器可读的错误，人类可读的那份仍写 stderr。形状、错误码与流事件见下文。

## 机器接口

给外壳与 GUI 的稳定约定。`--json` 时标准输出只有结果，进度与过程提示都走 stderr。

### 输出形状

顶层是对象时带 `"v": 1`；顶层是数组时不带 `v`，数组本身即 v1。缺失的标量用 `null`，不用空串。字段顺序不作保证，消费方按名字取。

`--version --json` 的 `api` 是机器接口版本：字段形状或语义发生破坏性变更时 +1。消费方按 `api` 判兼容，不按语义版本号。

| 命令                                | 顶层   | `v`  | 字段                                                                                                                                                                                                  |
| ----------------------------------- | ------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `folder list`                       | 数组   | 无   | 元素：`id:string` `name:string` `path:string` `exists:boolean` `writable:boolean` `instanceCount:number` `selected:boolean`                                                                           |
| `folder scan [id]`                  | 数组   | 无   | 元素：FolderView `id:string` `selectedInstance:string\|null` `name:string` `path:string` `exists:boolean` `writable:boolean` `versionsDirectory:string` `dropped:string[]` `instances[]`              |
| `folder add <path>`                 | 对象   | 有   | `id` `path` `versionCount`                                                                                                                                                                            |
| `folder add <path> --dry-run`       | 对象   | 有   | FolderView，含 `instances[]`                                                                                                                                                                          |
| `folder add <path> --no-select`     | 对象   | 有   | 同 `folder add <path>`，只是不改当前文件夹                                                                                                                                                            |
| `folder remove <id>`                | 对象   | 有   | `removed`                                                                                                                                                                                             |
| `folder select <id>`                | 对象   | 有   | `selected` `path`                                                                                                                                                                                     |
| `version list`                      | 对象   | 有   | 同 `folder scan` 的元素（FolderView）                                                                                                                                                                 |
| `version info <id>`                 | 对象   | 有   | `version list` 的 `instances[]` 元素加 `folder` 与 `descriptor`，且 `java.resolved` 有值                                                                                                              |
| `version select <id>`               | 对象   | 有   | `selected` `folder`                                                                                                                                                                                   |
| `version rename <旧> <新>`          | 对象   | 有   | `id` `from` `folder` `moved:boolean` `rewritten:string[]` `dryRun:boolean`                                                                                                                            |
| `launch [id]`                       | 对象   | 有   | `version` `executable` `java` `account` `directory` `classpath`(数字) `natives` `assets` `args[]` `selectedInstance` `pid` `log` `missing` `repair`                                                   |
| `launch [id] --dry-run`             | 对象   | 有   | 同上，`--dry-run` 不启动进程；`repair`、`pid` 与 `log` 恒为 `null`                                                                                                                                    |
| `launch [id] --repair`              | 对象   | 有   | `version` `directory` `missing` `repair`，不带启动计划                                                                                                                                                |
| `install <version>`                 | 对象   | 有   | `name` `versionId` `loader` `base` `clientJar` `libraries` `natives` `assets` `timing` `official` `warnings[]`                                                                                        |
| `mod search <关键词>`               | 数组   | 无   | 元素：`id:string` `slug:string` `title:string` `description:string` `downloads:number` `loaders:string[]` `gameVersions:string[]` `categories:string[]`                                               |
| `mod install <关键词>`              | 对象   | 有   | `instance` `mods` `project` `version` `files[]` `dependencies[]` `warnings[]`                                                                                                                         |
| `mod install <关键词> --async`      | 对象   | 有   | 队列任务：`id` `type` `target` `state` `params` `attempts` `created` `started` `finished` `progress` `error`；另给 `spawn:{outcome:string,pid:number\|null,log:string}`（这次拉起后台 worker 的结果） |
| `download info`                     | 对象   | 有   | `worker:number\|null` `tasks[]`（队列任务，同上）                                                                                                                                                     |
| `download info <id>`                | 对象   | 有   | `worker` `task`（单个队列任务）                                                                                                                                                                       |
| `download run`                      | 对象   | 有   | `recovered:string[]` `tasks[]`（`id` `type` `target` `state` `error`）`done` `failed` `cancelled`                                                                                                     |
| `download cancel <id>`              | 对象   | 有   | `id` `outcome`（`cancelled` 或 `aborting`）`task`                                                                                                                                                     |
| `download retry <id>`               | 对象   | 有   | 队列任务                                                                                                                                                                                              |
| `download clear`                    | 对象   | 有   | `removed:number`                                                                                                                                                                                      |
| `modpack <文件>`                    | 对象   | 有   | `name` `pack` `version` `files` `overrides` `warnings[]`                                                                                                                                              |
| `mirror list`                       | 对象   | 有   | `presets[]` `mirrors[]` `source`                                                                                                                                                                      |
| `mirror use <名字>`                 | 对象   | 有   | `source`                                                                                                                                                                                              |
| `mirror update`                     | 对象   | 有   | `from` `fetchedAt` `entries[]`                                                                                                                                                                        |
| `config get`                        | 对象   | 有   | `config`（整份 `setting.json`）                                                                                                                                                                       |
| `config get <键>` / `set` / `unset` | 对象   | 有   | `key:string\|null` `folder:string\|null` `instance:string\|null` `value`                                                                                                                              |
| `status`                            | 对象   | 有   | `cliVersion` `api` `node` `home` `logs` `host{platform,arch,memoryMb}` `java[]` `javaDefault` `memory{minMb,maxMb,globalMb,currentMb}` `folder` `mirror` `features[]`                                 |
| `view loader`                       | 对象   | 有   | `type` `loaders[]`（`name` `latest` `total`）                                                                                                                                                         |
| `view loader <名字>`                | 对象   | 有   | `loader` `type` `page` `pages` `perPage` `total` `versions[]`（`version` `gameVersion` `channel`）                                                                                                    |
| `view loader <名字> --game <版本>`  | 对象   | 有   | 同上，多 `game`                                                                                                                                                                                       |
| `view loader <名字> --games`        | 对象   | 有   | `loader` `page` `pages` `perPage` `total` `versions[]`（字符串数组）                                                                                                                                  |
| `view game <版本>`                  | 对象   | 有   | `game` `type` `page` `pages` `perPage` `total` `versions[]` `loaders[]` `warnings[]`                                                                                                                  |
| `auth list`                         | 数组   | 无   | 元素：`id:string` `type:string` `name:string` `uuid:string\|null` `selected:boolean` `status:string`；微软账户多 `xuid:string\|null` `expiresAt:string\|null` `hasCredential:boolean`                 |
| `auth login <游戏名>`               | 对象   | 有   | 账户：`id` `type` `name` `uuid`                                                                                                                                                                       |
| `auth login --type microsoft`       | NDJSON | 每行 | 见[设备码登录流](#设备码登录流)                                                                                                                                                                       |
| `auth logout <游戏名>`              | 对象   | 有   | `removed`                                                                                                                                                                                             |
| `auth use <游戏名>`                 | 对象   | 有   | `id` `name` `type`                                                                                                                                                                                    |
| `java list` / `java scan`           | 数组   | 无   | 元素：`path:string` `major:number\|null` `kind:string` `arch:string\|null` `vendor:string\|null` `source:string` `present:boolean`                                                                    |
| `java add <path>`                   | 对象   | 有   | `path` `major` `kind` `arch` `vendor` `source`                                                                                                                                                        |
| `java remove <path>`                | 对象   | 有   | `removed`                                                                                                                                                                                             |
| `java which`                        | 对象   | 有   | `path` `major` `kind` `arch` `vendor` `source` `home`；`--major <主版本>` 限定                                                                                                                        |
| `java install <主版本>`             | 对象   | 有   | `name` `url` `root` `java` `archive` `sha256` `size` `registered`                                                                                                                                     |
| `java install --provider mojang`    | 对象   | 有   | `provider` `component` `version` `platform` `url` `root` `java` `files` `bytes` `directories` `links` `registered`                                                                                    |
| 错误信封                            | 对象   | 有   | `error`                                                                                                                                                                                               |
| `--version --json`                  | 对象   | 有   | `version` `api`                                                                                                                                                                                       |

同一命令不同模式形状不同，读数前先认清是哪一种：

- `folder add <path>` 给摘要对象 `{id,path,versionCount}`，`folder add <path> --dry-run` 给 FolderView（含 `instances[]`）
- `launch [id]` 与 `launch [id] --dry-run` 形状相同，区别只在有没有真的启动，以及 `repair` 与 `pid` 有没有值
- `launch [id] --repair` 只给 `version` `directory` `missing` `repair` 四项，不带启动计划
- `java scan` 会把清单写回 `setting.json`，`java list` 只读

队列任务出现在 `--async`、`download info` 与 `download retry` 的输出里：

```
id:string  type:string  target:string  state:string  params  attempts:number
created:string  started:string|null  finished:string|null  progress  error
```

`state` 取值 `pending` `running` `done` `failed` `cancelled`，时间戳是 RFC3339 UTC。`progress` 为 `null` 或 `{stage:string,done:number,total:number,bytes:boolean,at:string}`；`error` 为 `null` 或 `{code:string,message:string,detail:string,retryable:boolean}`。`params` 在入队时定死（`query` `modsDirectory` `gameVersion` `loader` `withDependencies` `dryRun`），跑的时候只补上当前的网络设置。

`download info` 的 `worker` 是拿着 pid 锁的进程号，没有活的 worker 时为 `null`；队列文件里的 `running` 不等于有进程在跑，判断以 `worker` 为准。

`mod install --json --async` 在队列任务之外多给 `spawn`：这次拉起后台 worker 的结果。`outcome` 取值 `started`（已起进程）`busy`（下载进程已存在，任务自动入队）`disabled`（设了 `BLOOMERY_NO_WORKER=1`）`unavailable`（入口路径不可用）`failed`（子进程创建失败）；`pid` 只有 `started` 有值，其余为 `null`；`log` 是子进程的日志落点，恒有值。已有 worker 的 pid 看 `download info` 的 `worker`。

`launch` 的 `missing` 是这次检查的结果：

```
clientJar:boolean  libraries:number  natives:number  total:number  files:string[]
assets:{index:string,present:number,total:number|null,missing:number|null,size:number|null}|null
```

`assets` 是资源那类缺件：`index` 是索引 id，`present` 是本地已有的对象数，`total` 是索引里的对象数，`size` 是要下的字节数（版本 json 的 `totalSize` 加索引 json 自身）。索引整份不在本地时 `total` 与 `missing` 为 `null`（条数要等索引取回），`size` 只由版本 json 给出；这时的 `missing.total` 按一项（索引本身）计数。版本 json 里没有索引 id、或索引没有下载地址时 `assets` 为 `null`，这部分不补、不计入 `missing.total`。`files` 是缺件路径，客户端 jar、库、natives 依次在前，最多 8 条。

`launch` 顶层的 `assets` 是规划时的统计，形状与 `missing.assets` 相同（索引不在本地时为 `null`）。

`launch` 的 `repair` 为 `null` 表示这次没补（没有缺件，或 `--dry-run`）；补过时给 `clientJar` `libraries` `natives` `assets` 四类的下载报告（形状同 `install` 的对应字段，`downloaded` 是新下的个数，`skipped` 是已有的个数）、`timing` 与 `warnings[]`。

实例对象出现在 `folder scan` 元素的 `instances[]`、`version list` 的 `instances[]` 与 `version info` 里：

```
id:string  name:string  target:string  gameVersion:string|null  loader:{type:string,version:string|null}
state:string  type:string|null  directory:string  chain:string[]  configured:boolean  discovered:boolean
problem:string|null  lastPlayed:string|null  java:{required:{major:number},resolved:{major:number,path:string}|null}
```

`state` 取 `ready` / `missing` / `broken` / `incomplete`，`problem` 是读不出来时的原因。`version info` 在此之上多 `folder:string` 与 `descriptor`，`java.resolved` 才有值。

`folder list` 里是 `instanceCount`（数字，配置里的与磁盘上发现的取并集），`version list` 与 `folder scan` 里是 `instances[]`（数组），两者不通用。

### 错误信封

`--json` 失败时标准输出给一份机器可读的错误：

```json
{
    "v": 1,
    "error": {
        "code": "UsageError",
        "message": "参数不合法",
        "detail": "…",
        "exit": 2,
        "retryable": false,
        "context": {}
    }
}
```

- `code`：稳定错误码，见下表
- `message`：该码对应的中文短语
- `detail`：具体细节，没有细节时是空串
- `exit`：进程退出码，与真实退出码一致
- `retryable`：是否值得重试，只有 `DownloadFailed` 与 `DependencyMissing` 为 `true`
- `FileWriteFailed` 的 `detail` 是 `<errno> <路径>`（例如 `EROFS /home/u/.config/bloomery/setting.json`），数据目录不可写、磁盘满这类情况都归它，`UnknownError` 只留给意料外的分支
- `context`：恒存在，没有额外字段时是 `{}`；`detail` 之外的上下文键都落在这里

退出码分档：`0` 成功 / `1` 运行期失败 / `2` 参数不合法 / `3` 未实现。

| code                       | message                                  | exit | retryable |
| -------------------------- | ---------------------------------------- | ---- | --------- |
| `UnknownError`             | 内部错误                                 | 1    | false     |
| `UsageError`               | 参数不合法                               | 2    | false     |
| `UnknownCommand`           | 未知命令                                 | 2    | false     |
| `NotImplemented`           | 该功能尚未实现                           | 3    | false     |
| `ConfigTooNew`             | 配置版本比程序新                         | 1    | false     |
| `FileWriteFailed`          | 文件写入失败                             | 1    | false     |
| `FolderNotFound`           | 游戏文件夹不存在                         | 1    | false     |
| `FolderUnusable`           | 游戏文件夹不可用                         | 1    | false     |
| `FolderDuplicate`          | 游戏文件夹已经添加过                     | 1    | false     |
| `VersionNotFound`          | 版本不存在                               | 1    | false     |
| `VersionBroken`            | 无法读取版本文件                         | 1    | false     |
| `InstallBroken`            | 安装失败                                 | 1    | false     |
| `GameFilesMissing`         | 启动文件缺失                             | 1    | false     |
| `VersionExists`            | 版本已经存在                             | 1    | false     |
| `JavaNotFound`             | 找不到可用的 Java                        | 1    | false     |
| `JavaBroken`               | Java 跑不起来                            | 1    | false     |
| `JavaDuplicate`            | 这个 Java 已经在清单里                   | 1    | false     |
| `DependencyMissing`        | 依赖文件缺失                             | 1    | **true**  |
| `DownloadFailed`           | 下载失败                                 | 1    | **true**  |
| `WorkerBusy`               | 已有下载进程在运行                       | 1    | false     |
| `AccountNotFound`          | 找不到可用的账户                         | 1    | false     |
| `AccountExists`            | 这个账号已经在清单里                     | 1    | false     |
| `AccountExpired`           | 账户凭据需要刷新                         | 1    | false     |
| `MicrosoftClientIdMissing` | 微软登录缺少 client id                   | 2    | false     |
| `MicrosoftLoginFailed`     | 微软登录失败                             | 1    | false     |
| `MicrosoftNotOwned`        | 这个微软账户没有 Minecraft: Java Edition | 1    | false     |
| `ModNotFound`              | 没找到这个 MOD                           | 1    | false     |
| `ModUnsupported`           | 这个实例装不了这个 MOD                   | 1    | false     |
| `LaunchFailed`             | 游戏进程没起来                           | 1    | false     |

### 时间戳

一律 RFC3339 UTC、`Z` 结尾，允许带小数秒（产自 `Date.toISOString()`，例如 `2026-10-02T15:57:14.540Z`）。消费方按宽容解析处理，不要假定小数位数固定。"没有"用 `null`，不用空串。

现有字段：实例详情的 `lastPlayed`、账户的 `expiresAt`、`mirrors.json` 的 `fetchedAt`、`state.json` 的 `javaProbe[].probedAt`。

### 进度事件

`--progress ndjson` 把进度写成 NDJSON 到 **stderr**（标准输出不受影响），每行一个对象：

```json
{ "v": 1, "key": "library", "stage": "库", "done": 4617, "total": 59288230, "bytes": true }
```

- `key`：通道的稳定键，每条事件都有：`clientJar` / `library` / `natives` / `assets` / `files`。前四个是 `install` 与 `launch` 补全的四条通道，`files` 是逐文件下载（`java install --provider mojang` 与队列 worker）。消费方按 `key` 认通道
- `stage`：同一通道的显示名，`客户端 jar` / `库` / `natives` / `资源` / `文件`，随实现措辞变化，别拿它做判断
- `done` / `total`：`bytes` 为 `true` 时是字节数，否则是个数
- `bytes`：布尔，说明前两个字段的单位
- `existing`：可选，`true` 表示这批文件本地已有、这次没下
- `taskId`：可选，队列 worker 跑任务时带上的任务 id，消费端据此把事件归属到任务

节流 100ms 一条；首帧、新阶段与收尾必发；stderr 积压超过 64KB 时丢中间帧（收尾那条仍强制写），因此消费端再慢也不会拖慢下载。

### 设备码登录流

`auth login --type microsoft --json` 的 stdout 是 NDJSON，逐行一个事件：

```json
{"v":1,"event":"device","verificationUri":"https://www.microsoft.com/link","verificationUriComplete":null,"userCode":"4VZETTFG","expiresIn":900,"expiresAt":"2026-10-02T16:40:46.561Z","interval":5,"message":"在浏览器打开 …，输入代码 …"}
{"v":1,"event":"account","account":{"name":"…","uuid":"…","type":"microsoft"}}
{"v":1,"event":"error","error":{"code":"MicrosoftLoginFailed","message":"微软登录失败","detail":"申请设备码被拒","exit":1,"retryable":false,"context":{}}}
```

- `device` 先出，给网址、用户码与有效期；`verificationUriComplete` 实测恒为 `null`，微软不返回该字段
- `account` 登录成功后出
- `error` 失败时出，且必须是 stdout 的最后一行；`error` 的形状与错误信封里的 `error` 相同，编排层不再补信封
- 进程被 kill 不留半登录状态，账户文件要么没写要么写完

## 加载器

| 加载器   | 安装方式   | 版本号写法                                |
| -------- | ---------- | ----------------------------------------- |
| fabric   | 官方 meta  | `fabric@0.19.5`                           |
| quilt    | 官方 meta  | `quilt@0.20.0`                            |
| neoforge | 官方安装器 | `neoforge@20.6.141`                       |
| forge    | 官方安装器 | `forge@50.2.10` 或 `forge@1.20.6-50.2.10` |

版本号与游戏版本必须配对：

- neoforge 的版本号前两段即所需游戏版本（`20.6.x` 对应 1.20.6，`21.1.x` 对应 1.21.1）
- forge 的版本号以游戏版本为前缀，省略前缀时自动补
- 配对不符时直接报错，不下载安装器

省略加载器版本时取该游戏版本上最新的正式版。

forge 与 neoforge 走官方安装器：下载安装器到 `<文件夹>/.bloomery/`，执行完删除；过程需要本机 Java，按目标版本 json 的 `javaVersion` 挑（1.12.2 要 Java 8），耗时数分钟，输出实时透传。`--name` 指定实例名时，安装器写出的版本目录整份改名接管，继承链只留一层。

fabric 与 quilt 走官方 meta：拉到的 profile 是引用式的（`inheritsFrom` 指向游戏版本），安装时与原版 json 合并成一份自包含 json 写进实例目录。forge 与 neoforge 走官方安装器，装完同样与原版合并；四种加载器都只产出一个版本目录，见 [install](#install)。

读取侧两种布局都支持：外部启动器（官方启动器、PCL、HMCL）装出来的实例是引用式的，沿 `inheritsFrom` 递归合并仍在，`--repair` 与 `launch` 对它们照常工作。

## 存储

按 PCL / HMCL 的布局存放，只使用版本隔离模式：

```
<游戏文件夹>/
  versions/<实例 id>/
    <实例 id>.json        # 版本描述
    <实例 id>.jar         # 客户端 jar
    mods/                 # MOD
    config/               # 配置
    natives/              # 解出的本地库
  libraries/              # 共享库
  assets/                 # 共享资源
```

MOD、配置、存档都在实例目录下，互不影响。

`<实例 id>.json` 有两种形态：自包含（fabric / quilt 装出来的，带 `bloomery` 标记键，客户端 jar 就在实例目录里）与引用式（forge / neoforge 与外部启动器装出来的，`inheritsFrom` 指向基础版本目录，jar 用基础版本那份）。两种都能启动、补全与改名。

配置与日志：

```
~/.config/bloomery/
  setting.json            # 文件夹、账户、下载源、代理、并发、选中项
  state.json              # 上次启动的实例、Java 探测缓存
  accounts.json           # 账户，含凭据，权限收紧
  mirrors.json            # 拉来的下载源清单与拉取时刻
  downloads.json          # 下载队列的任务清单
  downloads.lock          # 队列 worker 的 pid 锁
  downloads.cancel        # 跨进程的取消请求
  logs/latest.log
  logs/worker.log         # 后台 worker 的正文，追加写
```

`--home <dir>` 时配置目录换成 `<dir>/.config/bloomery`，日志落点 `logs/` 也在这个目录下。

`state.json` 退出前在 `state.json.lock` 锁内重读一次，再重放本次进程改过的内容：多个进程共用同一个数据目录时，启动次数与上次游玩时间不会被后写的整份覆盖。

下载源、代理与并发在 `setting.json` 的 `network` 段（`concurrency` 默认 8，四类文件按任务数分配）。

代理也可用环境变量 `HTTPS_PROXY` / `HTTP_PROXY`；`network.proxy` 有值时优先于环境变量，`NO_PROXY` 命中的地址直连

## 中断与重入

全仓库没有信号处理：`SIGINT` 与 `SIGTERM` 直接终止进程，不写收尾状态。

- `install` 可续跑：已存在的文件逐个跳过，中断后重跑接着补
- 中断不更新 `state.json` 的启动统计，也不改队列任务的 `state`
- 队列里残留的 `running` 不作判据，判据是 `download info` 的 `worker` 字段；遗留任务由下次 worker 启动时标为失败，重跑走 `download retry <id>`
- 取消的对外结果看 `download cancel` 的 `outcome`（`cancelled` / `aborting`）

## 微软登录

内置应用 id 已通过 Mojang 审核，直接登录：

```bash
bloomery auth login --type microsoft
```

流程为设备码：终端给出一串代码与网址（<https://www.microsoft.com/link>），浏览器完成授权。凭据过期时启动前自动刷新。`--client-id <id>` 或环境变量 `BLOOMERY_CLIENT_ID` 可覆盖内置值。

加 `--json` 时 stdout 改为 NDJSON 事件流，见[设备码登录流](#设备码登录流)。

## 开发

```bash
npm run start -- <参数>     # 直接跑源码，Node 原生剥离类型
npm run check               # tsc --noEmit
npm test                    # node --test，270 项
npm run fmt                 # oxfmt 格式化
npm run build               # 产物到 dist/
```

分层：`cli → 功能模块 → platform / infra / output`。系统分支只出现在 `src/platform/`。

发版：`npm version <版本> --no-git-tag-version` → 提交 → 打 `v<版本>` 标签 → 推送。标签触发 npm 发布与 Release 打包。

## 许可

见 [LICENSE](LICENSE)。

## 联系

邮箱 xiangyuanhulian@outlook.com，站点 <https://bloomery.xyit.net>。
