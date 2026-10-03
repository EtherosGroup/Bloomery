# 更新记录

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
