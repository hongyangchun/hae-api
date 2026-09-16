# hae-api — Health Auto Export → Cloudflare 全免费云方案

iPhone Health Auto Export (HAE) → Cloudflare Worker（收数据+查询 API）→ D1 数据库 → 自建仪表盘 `/dashboard`。
无局域网依赖、无常驻进程、零月费。

## 接口一览

| 方法 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| POST | `/api/data` | `api-key: WRITE_KEY` | HAE 推送数据 |
| GET | `/` | 公开 | 健康检查 |
| GET | `/api/metrics` | `api-key: READ_KEY` | 指标清单（名称/单位/日期范围） |
| GET | `/api/query?name=step_count&from=2026-01-01&to=2026-09-01` | `api-key: READ_KEY` | 指标时间序列 |
| GET | `/api/query?name=vo2_max_est[&hrmax=185]` | `api-key: READ_KEY` | 心肺耐力估算（**派生指标**，读时计算、不落库） |
| GET | `/api/workouts?from=...&to=...` | `api-key: READ_KEY` | 锻炼记录 |
| GET/POST | `/dashboard` | `DASH_TOKEN`（口令换 Cookie） | 内置仪表盘（ECharts） |

日期均按 Asia/Shanghai 归天。数据格式兼容 HAE REST API JSON（与 iCloud 导出同源）。

**派生指标**：`vo2_max_est` 按 Uth 公式 `15 × HRmax / HRrest` 估算心肺耐力
（Apple Watch 只在户外步行/跑步时测 Cardio Fitness，只做力量/间歇/骑行的话
`vo2_max` 恒为空）。HRmax 取 90 天滚动窗口内的实测最大值，HRrest 取 7 日滚动均值；
响应里带 `hrmax_ref` / `hrmax_source` 与每天的 `rhr7` 便于解释。个体误差约 ±10~15%，
**只看趋势**。原理与守卫见 [`docs/design-notes.md`](docs/design-notes.md) 第三节第 6 小节。

`/dashboard` 内嵌于 `src/dashboard.js`（`dashboardHTML()`），随 Worker 一起部署，
**不需要单独托管、额外域名或独立仓库**。它走 `DASH_TOKEN` 口令 + 一年期签名 Cookie，
与上表的 `api-key` 头是两套彼此独立的鉴权体系。

> **密钥安全**：所有密钥（READ_KEY / WRITE_KEY / DASH_TOKEN）只在本地 `keys.local.md`、`DEPLOY.local.md` 和 wrangler secrets 里，不入库。
> **HAE v10 注意**：「健康 rest」自动化的「汇总数据」开关必须开启，否则睡眠数据会退化成碎片（服务端只收汇总格式，拒收碎片，见 worker.js 准入门禁）。

## 部署

```bash
git clone https://github.com/hongyangchun/hae-api.git && cd hae-api
npx wrangler login                        # 浏览器授权
npx wrangler d1 create hae-health         # 输出 database_id，填进 wrangler.toml
npx wrangler d1 execute hae-health --remote --file=schema.sql
npx wrangler secret put WRITE_KEY         # 手机上传凭证
npx wrangler secret put READ_KEY          # 查询凭证
npx wrangler secret put DASH_TOKEN        # 仪表盘口令
npx wrangler deploy
curl https://你的域名/                     # 期待 {"ok":true,...}
```

> ⚠️ 仓库里的 `wrangler.toml` 是实例配置，`database_id` 与 `routes` 必须换成你自己的值，
> 否则会把域名路由绑到别人的域名上。

**完整部署指导**（含 iPhone HAE 配置、「聚合数据」开关的正确设置、验收清单、排错速查）
→ [`docs/deployment.md`](docs/deployment.md)

## iPhone HAE 配置

Automations → New Automation（健康指标、锻炼各建一个）：

- Automation Type: **REST API**
- URL: `https://你的子域名/api/data`
- Headers: `api-key` = WRITE_KEY
- Data Type: Health Metrics / Workouts（分开两个自动化）
- Export Format: **JSON**
- **Aggregate Data: 开**，Aggregate Interval: **Days** ← 不开会导致睡眠数据被服务端准入门禁拒收
- Batch Requests: 开
- 历史回填：Manual Export 按月分段选日期导出

## 本地验证

```bash
node scripts/test_ingest.mjs   # 用 iCloud 里真实导出数据跑解析+mock 入库
npx wrangler dev               # 本地起 Worker，curl POST /api/data 实测
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/stack-overview.md`](docs/stack-overview.md) | **建议先读**：这套栈由哪几块组成、各在哪、关键决策与「不要做的事」 |
| [`docs/deployment.md`](docs/deployment.md) | 从零部署：六步、HAE 配置、「聚合数据」开关的正确设置、验收清单、排错速查、安全基线 |
| [`docs/link-contract.md`](docs/link-contract.md) | 数据契约：字段、`slot` 语义、写侧/读侧链路、必守规则 |
| [`docs/read-only-quickstart.md`](docs/read-only-quickstart.md) | 只读接入极简版（给需要用数据的人） |
| [`docs/design-notes.md`](docs/design-notes.md) | 设计笔记：选型理由、原理、踩过的坑 |
