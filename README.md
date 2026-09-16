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
| GET | `/api/workouts?from=...&to=...` | `api-key: READ_KEY` | 锻炼记录 |
| GET/POST | `/dashboard` | `DASH_TOKEN`（口令换 Cookie） | 内置仪表盘（ECharts） |

日期均按 Asia/Shanghai 归天。数据格式兼容 HAE REST API JSON（与 iCloud 导出同源）。

`/dashboard` 内嵌于 `src/dashboard.js`（`dashboardHTML()`），随 Worker 一起部署，
**不需要单独托管、额外域名或独立仓库**。它走 `DASH_TOKEN` 口令 + 一年期签名 Cookie，
与上表的 `api-key` 头是两套彼此独立的鉴权体系。

> **密钥安全**：所有密钥（READ_KEY / WRITE_KEY / DASH_TOKEN）只在本地 `keys.local.md` 和 wrangler secrets 里，不入库。
> **HAE v10 注意**：「健康 rest」自动化的「汇总数据」开关必须开启，否则睡眠数据会退化成碎片（服务端只收汇总格式，拒收碎片，见 worker.js 准入门禁）。

## 部署步骤（本机）

```bash
cd health-api-cf
npx wrangler login              # 浏览器授权
npx wrangler d1 create hae-health   # 输出 database_id，回填 wrangler.toml
# 编辑 wrangler.toml：填 database_id，取消 routes 注释并写上子域名
npx wrangler d1 execute hae-health --remote --file=schema.sql
npx wrangler secret put WRITE_KEY   # 随机长字符串
npx wrangler secret put READ_KEY    # 另一个随机长字符串
npx wrangler deploy
curl https://你的子域名/          # 期待 {"ok":true,...}
```

## iPhone HAE 配置

Automations → New Automation（健康指标、锻炼各建一个）：

- Automation Type: **REST API**
- URL: `https://你的子域名/api/data`
- Headers: `api-key` = WRITE_KEY
- Data Type: Health Metrics / Workouts（分开两个自动化）
- Export Format: **JSON**
- **Aggregate Data: 开**，Aggregate Interval: **Days** ← 不开会触发服务端 warnings
- Batch Requests: 开
- 历史回填：Manual Export 按月分段选日期导出

## 本地验证

```bash
node scripts/test_ingest.mjs   # 用 iCloud 里真实导出数据跑解析+mock 入库
npx wrangler dev               # 本地起 Worker，curl POST /api/data 实测
```
