# 更新记录

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
