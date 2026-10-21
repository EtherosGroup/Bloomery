# 元数据

## cn-names.tsv

MOD 中文名表。CLI 按 24h TTL 从 jsDelivr 拉取，缓存在 `<配置目录>/metadata/`。

- UTF-8，一行一个 `slug<TAB>中文名`；`#` 开头为注释，坏行跳过
- slug 是 Modrinth 的项目 slug
- 解析也认 `|` 分隔，仅用于本地与 PCL 的 WikiEntries.txt 对账
- 表头写明来源与生成日期；数据来自 MC百科（https://www.mcmod.cn/）模组列表的中文名与英文名
- 中文名只保留名称映射，不含描述、图标、下载等其它内容

## 生成

```
node metadata/generate.ts
```

- MC百科：`https://www.mcmod.cn/modlist.html` 逐页抓模组列表（约 989 页、3.2 万条），默认每页间隔 1.5s，遇 429 按 `Retry-After` 等待
- Modrinth：`/v2/search` 逐页抓 mod 清单（约 775 页、7.7 万条），默认每页间隔 300ms
- 两边按英文名归一化（小写、去空格与标点）后**精确匹配**；先比 slug、再比标题，括号段（`[ETF]`、`(JEI)`、`(Fabric)`）参与归一化
- 同名多义按下载量取最高的一项，下载量仍并列就跳过；同一个 slug 对上多条 MC百科记录时取匹配分更高、中文名更干净的那条
- 没有汉字的条目跳过（MC百科 本身就没给中文名，GUI 直接用英文名）
- 热门模组覆盖约四成：未命中的多是 MC百科 未收录、或英文名与 Modrinth 标题差异较大；宁缺不错
- 原始页面缓存在 `working/cn-names-cache/`，断点续跑；重抓用 `--refresh`
- 参数：`--pages <n>` / `--modrinth-pages <n>` 限制页数，`--delay` / `--api-delay` 调间隔，`--out` 改输出，`--dry-run` 只统计

抓取频率：每月一次足够。站点变更导致页数或结构变化时脚本会报解析错误，不会写出坏表。

## 托管

表推 master 后由 jsDelivr 提供主源（`https://cdn.jsdelivr.net/gh/EtherosGroup/Bloomery@master/metadata/cn-names.tsv`），GitHub raw 作备源。jsDelivr 的 gh 缓存约 12 小时刷新；要立即验证新表，用 `BLOOMERY_CN_NAMES_URL` 指向本地地址。

## 声明

数据来源：MC百科（https://www.mcmod.cn/）。表中只包含模组中文名与 Modrinth slug 的对应关系，生成与使用遵守低频抓取、注明来源的要求。
