# 更新记录

## 1.14.1

- 修 `version remove` / `version restore` 报 `VersionNotFound` 时 `context.folder` 的含义不一致：`remove` 走 CLI 的实例查找，给的是文件夹 id；`restore` 的版本不在列表里、只能由底层挪动逻辑报错，给的是绝对路径。现在两处都是文件夹 id，与 `version info`、`mod install` 等实例类错误的 `folder` 一致（真机验 1.14.0 时发现）

## 1.14.0

- 新增 `version remove <实例>`：把实例从列表里拿掉，**文件一个不删**。目录挪到 `<文件夹>/.removed/<实例>`，那里在 `versions/` 之外 —— 发现只认 `versions/` 下的目录，挪走就不会再被列出来，扫描也扫不回来
- 新增 `version removed`：列出这个文件夹里移除过的版本；新增 `version restore <实例>`：挪回 `versions/`
- 配置与统计都不动：`folders.<id>.instances.<id>` 里的内存与 jvmArgs、`state.instances` 里的游玩次数与上次时间都留着，移除只是让那条配置不再出现在列表里（`.removed/<实例>` 在时跳过它）。找回来之后设置原样有效，不用重配
- 当前选中项与 `state.lastInstance` 指向被移除的那个时才清掉，免得它们指着一个已经不在列表里的实例
- 三个动作都认 `--dry-run`

## 1.13.3

- 修资源索引拿不到时被静默跳过：索引下载失败、或下下来了读不出来，`prepareAssets` 只 push 一句警告然后返回 `null`，与「这个版本不需要资源」共用同一个返回值。于是补全当作没事发生，用户最后只看到一句 `GameFilesMissing · 资源索引 1.12`，既不知道是网络还是 json 缺地址，也没法重试。现在这两种情况就地抛错：网络类 `DependencyMissing`（可重试，`detail` 说明哪个索引没下下来，`first` 给落点与原因），校验不过、以及本地文件坏了 `InstallBroken`（`detail` 带上索引文件路径）
- `GameFilesMissing` 的 `context` 带上补全过程的 `warnings`（字符串数组）：失败路径上 `ensureFiles` 先抛异常、`RepairReport` 回不去，那句「没有资源索引 X 的地址」用户永远看不到。`ErrorContext` 因此允许字符串数组，人类可读那份按「；」拼起来
- 没动的两处：版本 json 里没有索引地址、索引文件坏在本地但「缺件检测」这一层，仍然按老策略不报缺件（补全补不动它们，报出来只会拦住启动）。这次踩到的是「有地址但索引没下来」，走的是第一条

## 1.13.2

- 新增错误码 `MicrosoftRefreshFailed`（微软凭据续期失败，`retryable` **true**）：换令牌这一趟的网络错误（连接失败、超时、DNS）原先没有收口，冒到上层变成「内部错误，这是 bug，请附带调用栈」。现在整条续期流程（换 OAuth 令牌 + Xbox / XSTS / Minecraft 三步）的非 `AppError` 失败都归到它，`detail` 是「网络请求失败」、原因挂在 `cause` 上
- 续期遇到 `HTTP 5xx` 与 `429` 也归到 `MicrosoftRefreshFailed`（`detail` 是 `HTTP <状态码>`）：这是微软那边这次没换成，凭据本身可能好好的，值得重试；真正的凭据失效（`invalid_grant` 这类 4xx）仍然是 `AccountExpired`，不会把用户往「重新登录」引错路
- 登录流程同样收口：设备码、Xbox、Minecraft 各步的非 `AppError` 失败改成 `MicrosoftLoginFailed`，不再漏成「内部错误」；已有的 `AppError` 原样透出，不会被裹一层
- `MicrosoftRefreshFailed` 进了可重试码集合，`--json` 信封里 `retryable` 为 `true`

## 1.13.1

- 修 `launch --dry-run` 会真去续期微软凭据：预览跑了一趟换令牌的网络往返，结果又因为不落盘丢掉，「先 dry-run 取计划、确认后再真启动」的外壳会等两次。现在 `--dry-run` 完全不碰网络，过期的账户在计划里用 `account.needsRefresh: true` 标出来，续期只在真启动那一次
- 顺带：预览时访问令牌过期不再报 `AccountExpired`（`planLaunch` 新增 `allowStaleAccount`），「令牌过期但能续」的账户照样出得来计划；没有 refresh token 的账户仍然拒绝，因为没人能把它换新
- 续期这一步加进度事件：`--progress ndjson` 下前后各一帧，通道 `key` 是新增的 `account`（`done` 0 → 1，`total` 恒为 1），外壳不用再猜卡在哪
- `launch --json` 的 `account` 多一个 `needsRefresh`；`mod search` / `mod list` 之外新增的 `mod` 通道见 1.13.0

## 1.13.0

- `mod search` 加按实例过滤：给 `--version` / `--folder` 就把该实例的游戏版本与加载器拼进 Modrinth 的 facets，也可用 `--game <版本>` / `--loader <名字>` 手写条件。原先只按 `project_type:mod` 搜，加载器或游戏版本对不上的结果要等到装的时候才失败
- 新增 `mod list`：扫实例 `mods/` 下的 jar 与 `.jar.disabled`，算文件 sha1 反查 Modrinth 补项目名与版本，反查不到（没发布过、限流、断网）退回文件名，单条查不到不影响其余；`--offline` 只扫盘。禁用约定定为 `foo.jar` ↔ `foo.jar.disabled`，加载器只认 `.jar`
- 新增 `mod remove` / `mod disable` / `mod enable`：接多个目标，逐条报告，没找到、重名、状态已经对、目标名被占用都记进 `skipped`（`reason` 是稳定机器键）而不是抛错，有跳过时退出码 1
- `mod install` 接多个目标：sync 逐条装、装不上的不中断其余，`--async` 一次入队后只拉起一次 worker
- `mod install` 的同步路径接上进度：`--progress ndjson` 出 MOD 下载的字节进度，通道 `key` 是 `mod`（新增的第六个通道）；`mod list` 的反查进度走同一个通道
- **机器接口破坏性变更，`api` 1 → 2**：`mod search --json` 从裸数组改成信封（`query` `instance` `gameVersion` `loader` `hits[]`）；`mod install --json` 改成 `installs[]` + `failed[]`（单条与多条同形状，失败条目带 `code` `detail` `retryable`）；`mod install --async --json` 改成 `tasks[]` + `spawn`。消费方按 `--version --json` 的 `api` 判兼容
- `mod install` 单条目标失败不再整条抛错，改由结果里的 `failed[]` 带出、退出码 1；非加载器实例这类整批前置条件仍当场报 `ModUnsupported`

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
