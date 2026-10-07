# 更新记录

## 1.12.6

- 修 `--detach` 下游戏进程活不过 CLI 退出（仅 Windows）：`unref` 只放开事件循环句柄，子进程仍与父进程共用控制台，CLI 退出时控制台被拆、JVM 在 1 秒内结束 —— 实例日志 0 字节、游戏自己的 `latest.log` 不生成，表现是「GUI 启动没有窗口，命令行正常」（命令行下 `waitForExit` 默认 true，父进程不退出）。两条 spawn 路径在 unref 时都给 `detached`，与后台 worker 同一套；Windows VM 实测 CLI 退出 25 秒后游戏仍在跑，GLFW30 窗口 `Minecraft 1.20.6` 已建立
- 实例日志开头先写一行启动记录（时间、实例名、真正被拉起的可执行文件）：游戏崩在写日志之前、或子进程一个字不输出时，这一行是唯一能区分「没起来」与「起来了但没输出」的线索

## 1.12.5

- Windows 上启动游戏改用同目录的 `javaw.exe`（探测 Java 仍走 `java.exe`）：`java.exe` 是控制台子系统程序，从无控制台的父进程（GUI）启动时，系统会为它新分配一个控制台窗口，那个窗口出现在桌面上并抢前台，把游戏窗口盖在后面。原版启动器在 Windows 上用的也是 `javaw.exe`
- 进程名随之变化：任务管理器里游戏进程从 `java.exe` 变成 `javaw.exe`（按 pid 认进程的不受影响）
- 本条只覆盖 `java.exe` 回退时多出的控制台窗口：`javaw.exe` 与 `java.exe` 手动拉起都正常出窗口，「GUI 启动没有窗口」的成因在 1.12.6（`--detach` 下子进程随父进程的控制台结束），与本条无关

## 1.12.4

- 新增错误码 `LoaderInstallFailed`（加载器安装失败，`retryable` false）：forge / neoforge 的官方安装器退出码非 0 时不再报 `DependencyMissing`。后者标着可重试，但安装器失败重试往往没用（Java 版本不符、安装器本身报错）—— 下载失败仍走 `DependencyMissing`，那条确实值得重试

## 1.12.3

- 挑官方安装器的 Java 改为从刚拉下来的原版 json 读主版本要求，不再读磁盘：全新文件夹里那份 json 还没落盘，旧实现读不到要求会退回默认目标 17，可能挑中 Java 21 去跑要 Java 8 的 1.12.2 Forge 安装器
- 挑不到 Java 时在下载原版之前就报 `JavaNotFound`（原先要等原版那一份下完才报）

## 1.12.2

- `install --loader forge|neoforge` 也改为合并成自包含实例：跑完官方安装器后与原版 json 合并，删掉 `inheritsFrom` 与 `jar`，客户端 jar 落在实例目录里。四种加载器现在都只产出一个版本目录
- 基础版本目录只在安装过程中临时存在：装完把它的客户端 jar 挪进实例目录（省一次重下）再删除。**用户本来就有的基础版本不动** —— 别的实例可能还在引用它
- 修复：取 forge 版本清单时的提示行原先直接写标准输出，`--json` 下会污染那份 JSON（`install 1.12.2 --loader forge --json` 的结果解析不出来）。改走 `logLine` 回调，与其余过程提示一致
- `install --json` 的 `official.versionDirectory` 改报合并后的实例目录名（原先报安装器写出的目录名，那个目录装完就被并掉了）

## 1.12.1

- 修复：既声明 `artifact` 又带 natives 的库只下 natives、不下 artifact，而类路径检查要求那份 artifact，导致安装与 `--repair` 永远报 `GameFilesMissing` 且补不上。官方 1.12.2 有 3 条（`lwjgl-platform:2.9.4-nightly-20150209` 的 artifact 是 22 字节空 jar）、1.16.5 有 16 条（`org.lwjgl:lwjgl` 等，是真正要用的 jar）。这是 v1.9.0 起就有的老问题

## 1.12.0

- `install --loader fabric|quilt` 改为在安装时把原版与加载器两层合并成一份自包含 json：实例目录自带客户端 jar，不再单独建基础版本目录，`versions/` 下只多一个目录；库与资源仍走共享的 `libraries/` 与 `assets/`
- 合并后的 json 删掉 `inheritsFrom` 与 `jar`，`id` 用实例名，并写入 `bloomery` 标记键记录游戏版本与加载器（`inheritsFrom` 不在之后，那是认这两样的唯一依据）
- 已知：`forge` / `neoforge` 仍走官方安装器的引用式两层布局（基础版本目录照旧存在），接入合并排在下一版
- ndjson 进度事件加稳定键 `key`：`clientJar` / `library` / `natives` / `assets` / `files`，首帧、换阶段与收尾都带；`stage` 保留中文显示名，判断依据换成 `key`
- `--version --json` 加 `api`：机器接口版本，破坏性变更时 +1，外壳按它判兼容
- `launch` 加 `--wait-for-exit` 与 `--detach`：覆盖 `setting.json` 的 `launch.waitForExit`，两个同时给报 `UsageError`，不给时行为不变
- `launch` 的结果加 `pid`（游戏进程号，`--dry-run` 时为 `null`）：`--detach` 之后子进程句柄随本进程退出失效，消费方按它认实例在不在跑
- 输出顺序调整：计划在起进程之后才打印，人类可读那行改成「进程 pid <数字>」
- `--json` 与 `--detach` 下游戏输出改追加到 `<日志目录>/instance-<实例 id>.log`，结果里的 `log` 给路径：原先继承 stdout，既污染 `--json` 的正文，又让 `--detach` 的调用方等到游戏结束才拿到管道 EOF
- `--detach` 时放开子进程句柄，本进程不再等到游戏退出才结束（实测由 3.1 秒降到 0.2 秒）
- 新增 `config get` / `set` / `unset`：按点分路径读写 `setting.json`，静态键覆盖默认值里的全部叶子，动态键覆盖 `folders.<id>` 与 `folders.<id>.instances.<id>`；值按 JSON 字面量认，`--string` 强制当字符串；`unset` 静态键回默认、动态键删项；别的命令维护的键（选中项、`java.list`、`download.sources`）报 `UsageError` 并指出入口
- `launch` 加 `--memory <mb>`：只影响本次启动的内存上限，低于生效下限报 `UsageError`
- `state.json` 退出前在锁内重读再重放本次改动：多个进程共用数据目录时，启动次数与上次游玩时间不再被后写的覆盖
- 新增 `status`：一次给出 CLI 与 Node 版本、数据目录与日志目录、平台与主机内存、Java 清单（含原样版本串与能否启动）、启动会用的那个 Java、内存上下界与当前值、当前文件夹与选中实例、下载源与可选源、能力键 `features[]`
- Java 探测结果与 `state.json` 的缓存加 `version`（`java.version` 原样串），`status` 与 `java list` 都能显示完整版本号
- `auth` 加 `use <游戏名> [--type]`：只切 `setting.json` 的当前账户，不登录、不联网、不碰凭据；重名判定与 `logout` 同一套（不给 `--type` 且同名多条报 `UsageError` 并列出类型），目标不存在报 `AccountNotFound`
- 新增错误码 `FileWriteFailed`：原子写失败（数据目录只读、磁盘满等）不再落成 detail 为空的 `UnknownError`，`detail` 给 `<errno> <路径>`，人类可读那份另附 `原因` 与「检查数据目录的写权限与剩余空间」
- `config` 支持 `--folder <id>` / `--folder <id> --instance <id>` 定位文件夹与实例的键：含点号的实例 id（`1.20.1-农夫`）原先点分寻址切不出来，现在 id 原样取用；输出加 `folder` 与 `instance` 字段，`key` 改为作用域内的键；旧的点分写法对不含点号的 id 仍然可用
- `version rename <旧名> <新名> [--dry-run]`：实例目录整份改名，json 与 jar 文件名跟着改；同步同一文件夹里其它版本的 `inheritsFrom` / `jar` 引用、配置项的 `id` 与 `target`、`selectedInstance`、`state.json` 的统计键与 `lastInstance`；返回 `rewritten` 列出被改引用的实例

## 1.11.0

- 新增下载队列：`mod install --async` 入队并立刻返回，`download info` / `run` / `cancel` / `retry` / `clear` 管理与查看
- `--async` 入队后分离拉起后台 worker：进程 detach 加 unref，父命令退出与终端 Ctrl+C 不影响子进程，stdout 与 stderr 追加到 `<日志目录>/worker.log`
- 已有存活 worker 时 `--async` 不再拉起，新任务由它接走；入口不可用或进程创建失败时任务留在队列里，用 `download run` 手动跑
- `mod install --async` 的输出与 JSON 多一个 `spawn`：拉起结果 `outcome`（`started` / `busy` / `disabled` / `unavailable` / `failed`）`pid` `log`
- `BLOOMERY_NO_WORKER=1` 时 `--async` 只入队（脚本与测试）
- `download info [id]` 给队列总览与单任务详情：状态、进度、错误码与 detail
- `download clear` 只清终态记录，pending 与 running 不动
- 队列是文件不是服务：任务清单在 `<数据目录>/downloads.json`，写入原子
- worker 一次一个任务，pid 锁保证只有一个；已有存活 worker 时再起 `download run` 报 `WorkerBusy`
- 上次没跑完的 `running` 任务在下次启动时回收为失败，重跑由 `download retry` 决定
- 进度写盘节流：状态变化必写，进度最多每秒一次；`download run` 的 ndjson 进度事件带 `taskId`
- `mod install --async` 对装不上的实例（非加载器版本、认不出游戏版本）当场报错，不入队
- MOD 目标校验收到 `requireModTarget` 一处，入队与安装共用同一份报错

## 1.10.0

- `java install` 新增 `--provider mojang`：按 Mojang 的 Java 运行时索引挑组件（非 snapshot 优先），按该平台清单逐文件下载并校验 sha1，还原可执行位与符号链接，先校验清单自身的 sha1；Mojang 只有 jre 组件
- `java install <主版本> --provider mojang --dry-run` 预览组件、平台、文件数与总大小
- `launch` 启动前自动补全缺失文件：客户端 jar、库、natives 走 install 那四类通道与进度事件，补不齐不起进程
- 新增 `launch <实例> --repair`：只做检查与补全就退出，不启动游戏，也不更新启动统计
- `launch --dry-run` 把缺件数写进结果，人类可读输出给一行提示
- `launch` 的 JSON 加 `missing` 与 `repair`，补过的四类各自给下载报告
- 资源索引整份不在本地时也算缺件：`--repair` 与普通启动连索引一起下，`--dry-run` 按版本 json 的 `totalSize` 报出待下载大小
- `launch` 的 `missing.assets` 加 `index` 与 `size`：索引不在本地时 `total` 与 `missing` 为 `null`，`size` 由版本 json 给出
- 补全失败按类型报错：网络类 `DependencyMissing` 可重试，sha1 校验不过 `InstallBroken` 不可重试
- 下载四类通道与客户端 jar 落点各收到一处，install、启动规划与补全共用
- `auth logout` 不给 `--type` 时按游戏名在全部账户里找，同名多条报用法错误并列出类型；原来按 offline 找，删微软账户会误报 `AccountNotFound`

## 1.9.0

- https 请求改用会调 `createConnection` 的 `https.Agent` 子类，`network.proxy` 与 `HTTPS_PROXY` 恢复生效
- `--json` 的对象输出统一带 `v: 1`，数组不带（数组本身即 v1）
- 补上 `mirror update` / `view game` / `--version --json` 三处漏掉的 `v: 1`
- 错误信封加 `retryable`，`context` 恒存在
- `folder list` 的实例数改为配置与磁盘的并集（`instanceCount`）
- 实例 JSON 加 `java{required,resolved}` 与 `lastPlayed`；`version info` 的 `java.resolved` 与启动用同一条选取规则
- 安装器 Java 按目标版本 json 的 `javaVersion` 挑（1.12.2 要 Java 8）
- `java install <主版本>`：下 Adoptium 压缩包解压并登记，不运行安装程序；校验 sha256
- `folder add --dry-run` 只校验并扫描，不落盘不改选中；`folder add --no-select` 登记但不设为当前
- `folder scan` 改为纯只读
- `java remove` 与 `folder remove` 只改配置，不删磁盘文件
- `auth login --type microsoft --json` 的 stdout 改为 NDJSON：device / account / error 三类事件，失败时 error 是最后一行
- `view loader <名字> --games` 去掉重复的 `games` 键
- `--home` 时日志落点也跟随，不再写默认配置目录
- 日志落点写失败时 stderr 不再打整段堆栈，只留一行原因（带落点文件）
- 注释与用户可见文案的语气清理

## 1.8.0

- `--progress ndjson`：机器可读进度事件走 stderr，节流 100ms，新阶段与收尾必发，积压超 64KB 丢中间帧
- `--json` 出错时标准输出一份机器可读的错误对象（`code` / `message` / `detail` / `exit`）

## 1.7.0

- 微软登录使用内置应用 id：`bloomery auth login --type microsoft` 不再需要 `--client-id`
- 内置应用 id 已通过 Mojang 审核，登录不再返回 403

麻将的处理速度还是很快的，处理结果也令我们非常开心，这封信意味着今后你可以使用Bloomery登入Microsoft账户并游玩Minecraft了！

## 1.6.3

- 下载源预置表与 `mirror` 命令：`list` / `use` / `update`
- `mirror update --from <地址>` 从镜像站拉取源清单，缓存到 `<配置目录>/mirrors.json`

## 1.6.2

- 安装器下载失败包装成正常错误，空闲上限放宽到 60 秒
- README 重写，按命令逐条说明

## 1.6.1

- 官方安装器改用适配版本的 Java（Forge 1.20.6 在 Java 25 上会卡死）
- `--name` 改名接管安装器产物，继承链只留一层
- 安装器参数按加载器取（forge 用 `--installClient`，neoforge 用 `--install-client`）
- `--json` 模式静默过程提示

## 1.6.0

- Forge 与 NeoForge 走官方安装器
- 加载器版本与游戏版本配对校验

## 1.5.1

- 四类下载各占一行进度条，同时刷新

## 1.5.0

- 客户端 jar、库、natives、资源合成一个队列并行下载

## 1.4.1

- `version select` 选中实例，`launch` 与 `mod install` 默认使用

## 1.4.0

- 整合包导入（Modrinth `.mrpack`）
