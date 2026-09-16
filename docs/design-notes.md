# Health Auto Export → Cloudflare 全免费云方案 · 原理与配置笔记

> 2026-09-03 搭建完成并全链路验证。零月费、无常驻进程、无局域网依赖。
> 密钥与地址备忘：`hae-api/keys.local.md`

---

## 一、一句话总结

iPhone 的 Health Auto Export（HAE）定时把 Apple Watch 健康数据推到 **Cloudflare Worker**（自写 API，负责鉴权+正确聚合+单位换算），存进 **Cloudflare D1** 数据库，由 **Worker 内置网页仪表盘** 展示、**教练 Agent 直读数据**做分析。全部落在免费额度内，Grafana 仅作备用已闲置。

```
iPhone HAE ──REST推送──▶ Cloudflare Worker (hae.qiaclass.com)
   (自动/手动)              │  鉴权 api-key
                            │  服务端按天聚合（累计型求和/均值型平均）
                            ▼
                        Cloudflare D1（metric_points / workouts 两张表）
                            │
            ┌───────────────┴────────────────┐
            ▼ 查询 API（READ_KEY）            ▼ 内置 /dashboard 网页（口令门禁）
       教练 Agent 直读分析              浏览器看趋势（手机/电脑）
```

## 二、为什么是它（选型结论）

| 方案 | 结论 |
|---|---|
| 官方 health-auto-export-server（Mac 局域网 Docker） | ❌ 依赖 Mac 常开 + 同一局域网，手机出门就断 |
| InfluxDB Cloud 免费版 | ❌ 只保留 30 天数据，看不了年度趋势 |
| 港区轻量云服务器 | ❌ 约 ¥30/月，还要自己运维 |
| **Cloudflare Worker + D1 + 内置仪表盘** | ✅ 免费、全球可达、Mac 合盖照常收数据、Agent 可直读 |

## 三、核心原理

### 1. 三密钥鉴权
- `WRITE_KEY`：只有 iPhone 推数据用（POST `/api/data`）
- `READ_KEY`：查询 API 用（Agent 直读 / Grafana 若启用）
- `DASH_TOKEN`：仪表盘门禁 + 登录页口令，**一物两用**（现为 `<DASH_TOKEN>`，2026-09-03 用户自定）
- Worker 校验 HTTP 头 `api-key`，不匹配返回 401；仪表盘走 Cookie（见 Step 3）

### 2. 服务端正确聚合（本项目最大的坑，见第五节）
无论 iPhone 侧聚合开关怎么设，**Worker 收到数据后都会按天重新聚合**（累计型求和、瞬时型平均），数据正确性由服务端保证：

| 数据类型 | 规则 | 例子 |
|---|---|---|
| 累计型（SUM_METRICS 列表） | 当天所有分段**求和** | 步数、活动/基础热量、距离、爬楼、锻炼环、站立 |
| 心率（带 Avg/Min/Max 字段） | avg 取均值、min 取最小、max 取最大 | heart_rate |
| 睡眠 | 直接取当日值（total/deep/rem/core/awake/inbed，单位小时） | sleep_analysis |
| 其余瞬时型 | 当天各分段**求平均** | HRV、血氧、静息心率、体重、呼吸率 |

iPhone 侧的正确配置是**开启聚合**（Aggregate Interval = Days）。早期版本开启后会把日合计错误地做成分段平均，但该 bug 的影响已被服务端的按天聚合吸收（每天 1 点求和 = 原值）；而在 v10 下**关闭**聚合会让睡眠退化成碎片、被准入门禁拒收。完整论证见 [deployment.md 第 3.3 节](deployment.md#33-聚合数据开关必须搞清的一个坑)。

- 日期统一按 **Asia/Shanghai** 归天（和 iPhone 上看到的一致）
- 写库用 UPSERT（按 指标+日期+slot 主键覆盖），**重复推送幂等**，回填不怕重

### 3. 单位换算在服务端做
- `?convert=kcal`：能量 kJ → kcal（÷4.184）
- `?convert=km`：距离 m → km
- 查询方（Agent/仪表盘/Grafana）直接拿成品数据，不用写公式

### 4. 数据模型（D1 / SQLite）
```
metric_points(metric, date, slot, qty, units)   -- 一天一格点
  slot: qty=普通 | avg/min/max=心率 | total/deep/rem/core/awake/inbed=睡眠
workouts(id, name, day, start, end, duration_min, kcal, distance, avg_hr, max_hr, raw)
```

### 5. 查询 API
| 端点 | 用途 |
|---|---|
| `GET /` | 健康检查（公开，可用作存活监控） |
| `GET /api/metrics` | 指标清单（名称/单位/覆盖日期范围/点数） |
| `GET /api/query?name=X&from=&to=&convert=` | 某指标的时间序列 |
| `GET /api/workouts?from=&to=` | 锻炼记录 |
| `POST /api/data` | HAE 推送入口（`preaggregated:true` 支持 Mac 本地预聚合回填） |

## 四、配置流程（可复现）

### Step 1 · Cloudflare 端（Mac 终端，一次性）
```bash
cd hae-api
npx wrangler login                                  # 浏览器点 Allow
npx wrangler d1 create hae-health                   # 把输出的 database_id 填进 wrangler.toml
npx wrangler d1 execute hae-health --remote --file=schema.sql
echo "<WRITE_KEY>" | npx wrangler secret put WRITE_KEY
echo "<READ_KEY>"  | npx wrangler secret put READ_KEY
npx wrangler deploy                                 # 自动绑定 hae.qiaclass.com
```
注意：`wrangler.toml` 里 `routes` 必须写在 `[[d1_databases]]` 块**之前**（TOML 归属规则）。

### Step 2 · iPhone HAE（两个自动化）
**自动化 A —— 健康指标**
- Type: REST API ｜ URL: `https://hae.qiaclass.com/api/data`
- Header: `api-key` = WRITE_KEY
- Data Type: Health Metrics ｜ Format: JSON
- **Aggregate Data: 开启**，Aggregate Interval: **Days**
- Batch Requests: 开

> **2026-09-16 更正**：此处原写「关闭」，那是针对早期 HAE 版本的结论 —— 当时开启聚合会把日合计错误地做成分段平均（步数 9925 → 16）。
> 服务端补上按天聚合（`aggregateMetric()` 对累计型求和）后，该 bug 的影响已被吸收：每天 1 点求和 = 原值，不会算错。
> 而**关闭**聚合在 v10 下会让睡眠退化成分段碎片，被服务端准入门禁拒收，导致睡眠数据整段缺失。
> **当前正确配置是「开启」**，完整论证见 [`deployment.md` 第 3.3 节](deployment.md#33-聚合数据开关必须搞清的一个坑)。

**自动化 B —— 锻炼**：同上，Data Type 选 Workouts（聚合开关无所谓）

**历史回填**：Manual Export 选日期范围逐段推（推荐按月分段），重复推没关系。
**指标勾选**：健康指标自动化已选「全选」——HAE 只推**有数据的类型**（无数据的连空数组都不发），所以库里指标会随时间自然增多，表结构零改动。新增指标唯一要盯的：若是累计型（类似步数）需加入 Worker 的 SUM_METRICS 求和名单，否则会被错误平均（教练 Agent 读数时会扫新指标名自动处理）。

### Step 3 · 可视化与读取
**A. 内置仪表盘（已上线，日常用这个）**
- 日常访问：`https://hae.qiaclass.com/dashboard`（**裸地址**）
- 新设备首次：访问 `https://hae.qiaclass.com/dashboard?t=<DASH_TOKEN>` 一次，或在登录页输口令（两者都是同一个 DASH_TOKEN 值），Cookie 记住一年
- 暗色主题、7/30/90/365 天切换、9 张图 + 6 个指标卡 + 锻炼表；ECharts 走 npmmirror 国内 CDN
- 换口令 = 改 DASH_TOKEN secret，所有设备 Cookie 立即失效重新登录（也是一键全员下线）

**B. Grafana Cloud（备用，已闲置）**
1. grafana.com 注册免费 stack → 装 Infinity 插件
2. 数据源：Base URL `https://hae.qiaclass.com`，Header `api-key`=READ_KEY，Allowed Hosts 加域名
3. Import `grafana-dashboard.json`（若 Infinity 版本差异导致空面板，用内置仪表盘即可）

**C. Agent 直读（真正的核心用途）**：直接问教练 Agent（如「我昨晚睡得怎么样」「这周练了几次」），它用 READ_KEY 查 /api/query 秒回分析；每天 08:00 早报也可挂云端周趋势。

## 五、踩坑记录（血泪经验）

1. **HAE 聚合语义错误（历史坑，现已由服务端吸收）**：早期版本开启 Aggregate Days 后，活动热量 2970 kJ/天 只推来 0.234 kJ；步程 4.1 km/天 只来 0.016 km——它把"日合计"错误做成了"分段平均"。当时结论是「关聚合、服务端自己算」。
   **2026-09-16 复核**：服务端已有 `aggregateMetric()`，每天 1 点的输入经过求和仍是原值，所以现在可以放心开启聚合并获得完整的睡眠数据。Worker 里那条「请在自动化里关闭 Aggregate Data」的响应警告（`worker.js` 第 351 行）是这次修正前的遗留启发式判断，在推荐配置下会持续误报，**应视为噪音**。详见 [`deployment.md` 第 3.3 节](deployment.md#33-聚合数据开关必须搞清的一个坑)。
2. **workers.dev 域名大陆被 DNS 污染**：iPhone 直连大概率失败，必须绑自有域名（Cloudflare 自定义域，免费）。
3. **Save & Test 有迷惑性**：它测的是公开的 `/`，通过≠鉴权配置对。查询端点 401 要看数据源 header 是否配对。
4. **401 排查**：十有八九是 key 复制被截断/带空格。用 `pbcopy` 把完整 key 放剪贴板再粘贴。
5. **平均值类指标在 HAE 聚合下也是对的**（HRV/血氧/静息心率验证过），错的只是累计型——别被"部分对"迷惑。
6. 代码变更用 `node scripts/test_ingest.mjs` 本地验证（mock D1 + 真实 iCloud 数据基准核对），再 `wrangler deploy`。
7. **聊天界面会把长字符串截断成 `sk-d-3…ffd2`**：从消息里复制 token 会拿到残缺值。对策：pbcopy 进剪贴板、把 token 换短（现为 6 位数字口令）。
8. **ECharts 重渲染必须先 dispose**：仪表盘切换天数范围时按钮曾重复追加、图表变空白——setRange 先 `innerHTML=''`，render 先遍历 `dispose()` 旧实例。
9. **睡眠数据两个语义坑**：① 日期 = 醒来那天早晨（09-03 的点 = 9-2 晚的觉），查「昨晚」要取今天的点；② 白天会推来当日的残夜点（不足 1h、结构全零），仪表盘已过滤 `total>1`；某晚 1.4h 结构全零 = 手表没戴/没测，不是数据丢了。

## 六、运维备忘

- **文件**：代码 `hae-api/`｜密钥与口令 `hae-api/keys.local.md`｜Grafana 备用面板 `hae-api/grafana-dashboard.json`
- **域名**：`hae.qiaclass.com`｜**仪表盘**：`/dashboard`（裸地址，口令见 keys.local.md）｜**D1**：hae-health (id b91ee90f-e928-497c-b15a-5d5cd7d5f59b)
- **改代码后**：`npx wrangler deploy`（10 秒生效）
- **手动查数**：`curl -H "api-key: <READ_KEY>" "https://hae.qiaclass.com/api/query?name=step_count"`
- **免费额度**：Worker 10 万请求/天、D1 5GB 存储（年度按天数据仅几 MB）——个人用量绰绰有余
- **与早报管线并行**：iCloud JSON → `parse_health_export.py` → 每天 08:00 简报，不受本方案影响
- **已知小缺口**：08-29 部分指标缺数据（HealthKit 当天来源问题，非链路问题）；今天的行在次日自动推送后覆盖为完整值
