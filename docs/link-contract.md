# 健康数据链路对接手册（转交版）

> 目的：给另一个 Agent 对接同一套健康数据。**只需读数据 → 看第 2、3 节**；要复现整套链路 → 看第 4、6 节。
> 本文档不含任何密钥，密钥事宜见第 7 节。

## 1. 架构总览

```
Apple Watch 10 ──▶ iPhone 健康 App
                     │ Health Auto Export (HAE, Premium)
                     ├─ REST 自动化 ×2 ──▶ Cloudflare Worker (hae.qiaclass.com) ──▶ D1   ← 主链路，直读这里
                     ├─ iCloud 自动化 ×2 ─▶ iCloud Drive JSON                           ← 备用（Mac 本机读）
                     └─ Google 自动化 ×2 ─▶ Google Drive                                ← 异地备份，无人读
```

- **主链路**：iPhone HAE 定时 REST 推送 → 自建 Cloudflare Worker（鉴权+按天聚合）→ Cloudflare D1。实时、全天候、不依赖 Mac 开机。
- 查询侧入口：API（Agent 用）、内置网页仪表盘 `/dashboard`。Grafana 方案已弃用闲置。

## 2. 读侧对接规范（核心）

- Base：`https://hae.qiaclass.com`
- 鉴权：HTTP header `api-key: <READ_KEY>`（READ_KEY 获取方式见第 7 节）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 健康检查（公开） |
| GET | `/api/metrics` | 指标清单（名称/单位/覆盖日期范围/点数） |
| GET | `/api/query?name=X&from=YYYY-MM-DD&to=YYYY-MM-DD[&convert=kcal\|km]` | 指标时间序列 |
| GET | `/api/query?name=vo2_max_est[&hrmax=185]` | 心肺耐力估算（派生指标，不落库） |
| GET | `/api/workouts?from=&to=` | 锻炼记录 |

**响应格式**：
- `/api/query` → `{"units": "...", "points": [{"date": "YYYY-MM-DD", "qty": 123, ...}]}`
- 日期闭区间（含 from 与 to），按 **Asia/Shanghai** 归天（与 iPhone 显示一致）
- `slot` 字段：普通指标是 `qty`；`heart_rate` 是 `avg/min/max` 三列；`sleep_analysis` 是 `total/deep/rem/core/unclassified/awake/inbed`（单位：小时）
- 能量类默认 kJ，加 `&convert=kcal` 换算；距离加 `&convert=km`
- `vo2_max_est` 走同一个 `/api/query` 入口但**不在 `metric_points` 里**，是读时按
  `15 × HRmax / HRrest` 现算的；`qty` 之外每天还带 `rhr7` / `rhr_n`，响应顶层带
  `hrmax_ref` / `hrmax_source`。数据不足时 `points` 为空且带 `reason`，**不是报错**。
  另有 `vo2_max` 这个原始指标，本账号**恒为空数组**（Apple 不测），别拿它当数据缺失。

**必踩的坑（都会导致对接失败或读错数）**：
1. **Python urllib/requests 默认 UA 会被 403 拦截** → 请求必须带自定义 User-Agent（如 `hae-fetch/1.0`）
2. 401 = key 错（多半是复制被截断或带空格）；403 = UA/防火墙问题
3. **睡眠日期 = 醒来那天早晨**：查「昨晚睡眠」要取**今天**的 `sleep_analysis` 点；白天出现的当日残夜点（total<1h、结构全零）是噪音，过滤掉
4. 能量不传 `convert=kcal` 会差 4.184 倍（kJ 当 kcal 看错数量级）
5. workers.dev 域名大陆被 DNS 污染，必须用 `hae.qiaclass.com` 自定义域
6. **静息心率/HRV 的值在 `qty` 槽**，不是 `avg`（`avg` 只属于聚合心率 `heart_rate`）；历史上一批回填数据曾写错槽，已用迁移脚本并入 `qty`

**快速验证**：
```bash
curl -H "api-key: $READ_KEY" -H "User-Agent: hae-fetch/1.0" \
  "https://hae.qiaclass.com/api/query?name=step_count&from=2026-09-01&to=2026-09-05"
```

## 3. 现成脚本与定时任务（Mac 本机）

- `scripts/fetch_health_api.py`（主）：`python3 scripts/fetch_health_api.py [--date YYYY-MM-DD]`，拉 API 生成 `health/latest.md` + `health/latest.json`。内置 13 项常用指标：睡眠、静息心率、HRV、血氧、活动/基础热量、步数、步行距离、锻炼环、站立、骑行距离、体重、腕温
- `scripts/parse_health_export.py`（备）：解析 iCloud JSON，仅 API 不可用时用
- 定时任务：cron「每日健康简报」，每天 08:00（Asia/Shanghai）跑主脚本拉昨日数据，webchat 输出四段简报（恢复/活动/锻炼/今天建议）

## 4. 写侧链路（HAE 如何推上来）

**iPhone HAE 两条 REST 自动化**（健康指标、锻炼各一条）：
- Automation Type: **REST API** ｜ URL: `https://hae.qiaclass.com/api/data`
- Header: `api-key` = WRITE_KEY ｜ Export Format: **JSON**
- Data Type: Health Metrics / Workouts 分开建
- **Aggregate Data: 开启**，Aggregate Interval: **Days**（v10 下必须开启：关闭会让睡眠数据退化成分段碎片，被服务端准入门禁拒收）

> 这条结论有过一次反转，接入前值得知道：早期 HAE 版本开启聚合后会把「日合计」错误地做成分段平均（实测步程 4.1 km/天只推来 0.016 km），当时的正确做法是关闭。服务端补上按天聚合（`aggregateMetric()` 对累计型求和）后，该问题已被吸收 —— 每天 1 点求和 = 原值，不会算错。详细论证见 [deployment.md 第 3.3 节](deployment.md#33-聚合数据开关必须搞清的一个坑)。
- Batch Requests: 开；历史回填用 Manual Export 按月分段推（写库是 UPSERT，重复推幂等不怕重）

**服务端聚合规则**（`src/worker.js`）：
| 类型 | 规则 | 例子 |
|---|---|---|
| 累计型（SUM_METRICS 名单） | 当天全分段**求和** | 步数、活动/基础热量、距离、锻炼环、站立 |
| heart_rate（带 Avg/Min/Max） | avg 均值、min 最小、max 最大 | 心率 |
| sleep_analysis | 直取当日值 | 睡眠 |
| 其余瞬时型 | 当天各分段**平均** | HRV、血氧、静息心率、体重 |

**数据模型**（D1/SQLite）：`metric_points(metric, date, slot, qty, units)` + `workouts(id, name, day, start, end, duration_min, kcal, distance, avg_hr, max_hr, source, raw)`，主键 UPSERT 幂等。

## 5. 备用链路明细

- **iCloud JSON**：容器 `~/Library/Mobile Documents/iCloud~com~ifunography~HealthExport/Documents/`，当前目录 `健康 iCloud/`、`锻炼 iCloud/`（各放 `HealthAutoExport-YYYY-MM-DD.json`）。iPhone 快捷指令「运动结束」「每天睡醒关闹钟」触发 HAE Run Automation 导出。注意：Mac 端 HAE 容器同步慢，Finder 勾「保留已下载」可缓解
- **Google Drive**：两条自动化推「每日备份健康」「每日备份锻炼」文件夹，纯异地备份，无人读取
- **AutoSync**：Mac HAE App 的 `AutoSync/*.hae`，给 HAE for Mac 自己用，对接方不需要管

## 6. 自建复现步骤（若要另起一套）

Cloudflare 全免费方案，部署顺序：
```bash
cd hae-api
npx wrangler login                                # 浏览器授权
npx wrangler d1 create hae-health                 # database_id 回填 wrangler.toml
npx wrangler d1 execute hae-health --remote --file=schema.sql
npx wrangler secret put WRITE_KEY                 # 随机长字符串
npx wrangler secret put READ_KEY                  # 另一个随机长字符串
npx wrangler deploy                               # 绑自定义域名
```
注意：`wrangler.toml` 里 `routes` 必须写在 `[[d1_databases]]` **之前**（TOML 归属规则）；必须绑自有域名（workers.dev 大陆不可用）。代码与验证脚本：`hae-api/`（`src/worker.js`、`schema.sql`、`scripts/test_ingest.mjs` 本地 mock 验证）。改代码后 `npx wrangler deploy` 约 10 秒生效。

## 7. 密钥与安全

- 所有密钥仅存本机：`hae-api/keys.local.md`（WRITE_KEY 推送用 / READ_KEY 查询用 / DASH_TOKEN 仪表盘口令 / D1 database_id）
- **本文档不含密钥**。转交 READ_KEY 请走安全通道（密码管理器/当面），勿贴群聊、勿进代码仓库
- 仪表盘：`https://hae.qiaclass.com/dashboard`，口令 = DASH_TOKEN（6 位数字），首次 `?t=<token>` 登录后 Cookie 记一年
- 聊天窗口会把长 key 截断显示，复制用 `pbcopy` 全量粘贴

---
*整理自 2026-09 搭建记录，主链路 2026-09-03 上线并全链路验证。*
