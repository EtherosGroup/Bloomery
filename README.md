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

```bash
bloomery launch                            # 启动默认实例
bloomery launch 1.20.6-fabric-0.19.5       # 指定实例 id
bloomery launch --dry-run                  # 只打印启动计划
bloomery launch --account cibocaz          # 指定账户
bloomery launch --folder mc                # 指定文件夹
```

启动当前选中实例时，首行给出提示。

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

### auth

账户管理。离线账户立即可用，微软账户见下文。

```bash
bloomery auth login cibocaz                      # 离线账户
bloomery auth login --type microsoft             # 微软设备码登录
bloomery auth list
bloomery auth logout cibocaz
```

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
```

目标实例省略时同 `launch` 的规则。文件落在该实例自己的 `mods/` 下，同名文件已存在时跳过。目前只接 Modrinth。

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
```

选中后 `launch` 与 `mod install` 省略版本时都用它。优先级：命令行给的 > 当前选中 > 上次启动 > 第一个可用。

### folder

```bash
bloomery folder add ~/.minecraft                 # 登记
bloomery folder list
bloomery folder scan ~/.minecraft                # 扫描磁盘上已有版本
bloomery folder select mc                        # 切换当前文件夹
bloomery folder remove mc
```

### java

```bash
bloomery java scan                               # 扫描
bloomery java list
bloomery java add /usr/lib/jvm/jdk-21/bin/java
bloomery java which 1.20.6                       # 该版本会用哪个 Java
bloomery java remove /path/to/java
bloomery java list --major 21
```

### mirror

查看与切换下载源。默认 Mojang 官方直连。

```bash
bloomery mirror list                             # 预置源与当前选择
bloomery mirror use bmclapi                      # 切到 BMCLAPI
bloomery mirror use official                     # 切回官方
bloomery mirror use custom --url https://mirror.example.com
```

预置源在 `src/infra/source.ts` 的 `SOURCE_PRESETS` 表里，加源加一行。BMCLAPI 只改写 Mojang 主机（库、资源、版本 json），Forge 等第三方 maven 原样直连。写入的是 `setting.json` 的 `download.sources`。

### 全局选项

```
-v, --verbose     输出调试日志
-q, --quiet       只输出警告与错误
    --json        以 JSON 输出结果
-h, --help        显示帮助
-V, --version     显示版本号
```

`--json` 下标准输出只有一份 JSON，过程提示静默。

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

forge 与 neoforge 走官方安装器：下载安装器到 `<文件夹>/.bloomery/`，执行完删除；过程需要本机 Java，耗时数分钟，输出实时透传。`--name` 指定实例名时，安装器写出的版本目录整份改名接管，继承链只留一层。

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

配置与日志：

```
~/.config/bloomery/
  setting.json            # 文件夹、账户、下载源、代理、并发、选中项
  state.json              # 上次启动的实例、Java 探测缓存
  logs/latest.log
```

下载源、代理与并发在 `setting.json` 的 `network` 段（`concurrency` 默认 8，四类文件按任务数分配）。

## 微软登录

代码已就绪，等待 Mojang AppID 审核。审核通过前，微软登录返回 403。

```bash
bloomery auth login --type microsoft --client-id <azure 应用 id>
```

流程为设备码：终端给出一串代码与网址，浏览器完成授权。凭据过期时启动前自动刷新。

## 开发

```bash
npm run start -- <参数>     # 直接跑源码，Node 原生剥离类型
npm run check               # tsc --noEmit
npm test                    # node --test，167 项
npm run fmt                 # oxfmt 格式化
npm run build               # 产物到 dist/
```

分层：`cli → 功能模块 → platform / infra / output`。系统分支只出现在 `src/platform/`。

发版：`npm version <版本> --no-git-tag-version` → 提交 → 打 `v<版本>` 标签 → 推送。标签触发 npm 发布与 Release 打包。

## 许可

见 [LICENSE](LICENSE)。

## 联系

邮箱 xiangyuanhulian@outlook.com，站点 <https://bloomery.xyit.net>。
