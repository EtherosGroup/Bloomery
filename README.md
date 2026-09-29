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

`bloomery --version` 看当前版本，`bloomery --help` 列出全部命令，`bloomery <命令> --help` 看单个命令。

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
