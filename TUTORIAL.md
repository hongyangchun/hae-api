# 健康数据上云：Health Auto Export → Cloudflare 全免费方案

一句话：iPhone 健身数据（心率、睡眠、步数、锻炼……）实时推到自己的 Cloudflare，自带查询 API 和网页仪表盘，无局域网依赖、无常驻进程、零月费。

```
iPhone (HAE 自动化，每5分钟) ──POST──▶ Cloudflare Worker (/api/data)
                                          │
                                          ▼
                                       D1 数据库
                                          │
                       查询 API (/api/metrics /api/query /api/workouts)
                       网页仪表盘 (/dashboard)
```

## 准备

- iPhone：Health Auto Export（需 Premium，买断制）
- Cloudflare 免费账号
- 电脑：Node.js ≥ 18
- 本项目代码：`git clone` 本仓库

## 五步搭建

### 1. 登录 Cloudflare

```bash
npx wrangler login        # 浏览器授权
```

### 2. 创建 D1 数据库

```bash
npx wrangler d1 create hae-health
# 把输出里的 database_id 填进 wrangler.toml
```

### 3. 建表 + 配置密钥

```bash
npx wrangler d1 execute hae-health --remote --file=schema.sql

# 生成三个随机密钥（openssl rand -hex 24），逐个执行：
npx wrangler secret put WRITE_KEY    # HAE 上传凭证
npx wrangler secret put READ_KEY     # 查询 API 凭证
npx wrangler secret put DASH_TOKEN   # 仪表盘口令
```

### 4. 部署

```bash
npx wrangler deploy
curl https://你的域名/          # 期待 {"ok":true,...}
```

### 5. iPhone HAE 配置（关键步骤）

HAE → 自动化 → 新建 → 目的地选 **REST API**：

| 配置项 | 值 |
|---|---|
| URL | `https://你的域名/api/data` |
| Header | `api-key` = WRITE_KEY |
| 格式 | JSON |
| 同步频率 | 每 5 分钟 |
| **汇总数据 (Aggregate Data)** | **必须开** |
| Aggregate Interval | Days |
| Batch Requests | 开 |

> ⚠️ **汇总数据必须开**。HAE v10 关掉它会把睡眠数据退化成零散片段，服务端只收汇总格式、拒收碎片。

## 验证

```bash
curl -H "api-key: <READ_KEY>" https://你的域名/api/metrics
```

手机走两步，等 5 分钟后再查 `step_count` 有增长即通。

## 日常使用

```bash
# 指标时间序列
curl -H "api-key: <READ_KEY>" "https://你的域名/api/query?name=step_count&from=2026-01-01"

# 锻炼记录
curl -H "api-key: <READ_KEY>" "https://你的域名/api/workouts?from=2026-09-01"
```

- 网页仪表盘：`https://你的域名/dashboard`（输入 DASH_TOKEN，Cookie 记住一年）
- 日期全部按 Asia/Shanghai 归天
- iPhone 锁屏期间推送可能延迟，数据不丢，解锁后自动补推

## 历史数据回填（可选）

刚搭完想把过去的健康数据也导进去：HAE → Export → 手动导出 JSON（可按日期分段选），逐个文件 POST 到 API 即可：

```bash
curl -X POST -H "api-key: <WRITE_KEY>" -H "Content-Type: application/json" \
  --data-binary @HealthAutoExport-2026-08-01.json https://你的域名/api/data
```

## 本地验证（改代码后）

```bash
node scripts/test_ingest.mjs   # 用真实导出数据跑解析 + mock 入库
npx wrangler dev               # 本地起 Worker 实测
```
