# Bloomery 启动器

Minecraft 启动器：命令行操作，零运行时依赖，只支持版本隔离（一个版本一个目录）。

## 安装

需要 Node 20 或更新。

```bash
# 从 npm 装
npm i -g bloomery

# 或跟着仓库走
npm i -g github:EtherosGroup/Bloomery          # 最新主干
npm i -g github:EtherosGroup/Bloomery#v1.1.3   # 指定标签
```

## 更新

```bash
npm i -g bloomery@latest                    # npm 装的
npm i -g github:EtherosGroup/Bloomery       # 仓库装的，重装即最新
```

`npm -g update bloomery` 也能用，但它只认 npm 装的：git 装的或从目录装的会被跳过，所以上面两条更明确。

## 快速开始

```bash
bloomery folder add ~/Game/Minecraft            # 记录游戏文件夹，第一个会自动设为默认
bloomery auth login Steve                       # 离线账户
bloomery install 1.20.6                         # 装原版
bloomery install 1.20.6 --loader fabric@latest  # 连加载器一起装
bloomery launch 1.20.6                          # 启动
```

有多个游戏文件夹时，换默认用 `folder select`，只对一次生效用 `--folder`：

```bash
bloomery folder list
bloomery folder select Minecraft
bloomery launch 1.20.6 --folder Minecraft
```

### 装 MOD

```bash
bloomery mod search sodium                          # 从 Modrinth 检索
bloomery mod install sodium --version 1.20.6-fabric # 装到指定实例
bloomery mod install sodium-extra --deps            # 连必需依赖一起装
```

装到哪个实例按 `--version` 定，省略就用上次启动的那个。文件落在该实例自己的 `mods/` 下，同名文件已存在会跳过，`--dry-run` 只算不装。目前只接了 Modrinth（`setting.json` 里的 `mod.provider`）。

### 看加载器版本

```bash
bloomery view loader                  # 四种加载器的最新版与版本数
bloomery view loader fabric           # 某个加载器的全部版本，每页 20 条
bloomery view loader fabric --page 2  # 翻页
bloomery view loader neoforge --type release   # 只看正式版，可选 release / beta / alpha

bloomery view loader fabric --game 1.20.6      # 这个游戏版本上可用的加载器版本
bloomery view loader fabric --games            # 这个加载器支持哪些游戏版本
bloomery view game 1.20.6                      # 这个游戏版本上四种加载器各有哪些版本
```

版本清单直接取自各加载器的官方接口（Fabric / Quilt 的 meta、Forge 与 NeoForge 的 maven）。安装目前只支持 fabric，另外三种的版本号可以查，装的时候会提示未实现。

### 导入整合包

```bash
bloomery modpack ~/下载/SomePack.mrpack       # 按包里的游戏版本与加载器建实例
bloomery modpack pack.mrpack --name MyPack    # 指定实例名
bloomery modpack pack.mrpack --dry-run        # 只算不导入
bloomery modpack pack.mrpack --no-assets      # 跳过资源对象，只装游戏本体
```

只认 Modrinth 的 `.mrpack`：清单里的文件按落点下载并校验 sha1，`overrides/` 与 `client-overrides/` 摊到实例目录，清单里没有下载地址的文件只记警告。加载器安装目前只支持 fabric，包里要 forge / neoforge / quilt 时会报未实现。

`bloomery --version` 看当前版本，`bloomery --help` 列出全部命令，`bloomery <命令> --help` 看单个命令。

## 微软登录

```bash
bloomery auth login --type microsoft --client-id <Azure 应用 id>
```

也可以先把 id 放进环境变量 `BLOOMERY_CLIENT_ID`，之后直接 `bloomery auth login --type microsoft`。

终端会给出网址与代码，浏览器里授权完成后自动继续。凭据按账号存进 `accounts.json`（0600），启动时访问令牌过期会自动续期，不用每次重登。

client id 取自 Azure 应用注册里的「应用程序(客户端) ID」。应用要三项配置：支持的账户类型选「任何组织目录中的账户和个人微软账户」、认证页打开「允许公共客户端流」（设备码流程需要）、不需要客户端密码。

**能不能真登进去**：Minecraft 服务会校验 client id 是否获批。自注册的应用一般前几步都成功、到 `login_with_xbox` 收到 `403 Invalid app registration`，这个提示会原样报出来。Mojang 目前没对新的第三方启动器开放申请（正规通道要 ID@Xbox，且需要一个能提交审核的游戏），所以现实做法是在 `--client-id` 里填一个已获批的 id，或改走第三方认证（`auth login --type custom`，authlib-injector）。

## 开发

```bash
npm install
npm test          # node --test，不用先构建
npm run check     # tsc --noEmit
npm run fmt       # oxfmt
npm start -- --help
```

## 许可

Apache-2.0，见 [LICENSE](LICENSE)。

## 联系

官网 <https://bloomery.xyit.net>，邮箱 xiangyuanhulian@outlook.com，或在 [Issues](https://github.com/EtherosGroup/Bloomery/issues) 里提。
