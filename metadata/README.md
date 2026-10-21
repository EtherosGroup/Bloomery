# 元数据

## cn-names.tsv

MOD 中文名表。CLI 按 24h TTL 从 jsDelivr 拉取，缓存在 `<配置目录>/metadata/`。

- UTF-8，一行一个 `slug<TAB>中文名`；`#` 开头为注释，坏行跳过
- slug 是 Modrinth 的项目 slug
- 解析也认 `|` 分隔，仅用于本地与 PCL 的 WikiEntries.txt 对账
- 数据来自 MC百科（mcmod.cn），表中只保留名称映射；转载与抓取频率由维护者确认后再提交
- 生成脚本与覆盖率的核对流程在数据源确认后补上；本目录目前只有约定，没有随包的第三方快照

推 master 后 jsDelivr 的 gh 缓存约 12 小时刷新；要立即验证新表，用 `BLOOMERY_CN_NAMES_URL` 指向本地地址。
