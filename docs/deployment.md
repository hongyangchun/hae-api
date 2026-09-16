# 部署指南 · 从零搭一套

> 本文**不含任何密钥**，可公开。照着做能在自己的 Cloudflare 账号下独立部署一套完整可用的链路。
> 前置阅读：[`../README.md`](../README.md) 了解接口一览，[`link-contract.md`](link-contract.md) 了解数据契约。

---

## 0. 这套东西是什么

```
iPhone（Health Auto Export 自动化）
   │  POST /api/data      header: api-key = WRITE_KEY
   ▼
Cloudflare Worker  ── 鉴权 → 按天聚合 → 单位换算 ──┐
                                                  ▼
                                          Cloudflare D1
                                     metric_points / workouts
                                                  │
              ┌───────────────────────────────────┴──────────────┐
              ▼                                                  ▼
   查询 API（READ_KEY）                                  /dashboard（网页）
   /api/metrics /api/query /api/workouts              口令换一年期 Cookie
```

一句话：**手机推数据 → 云端收下并按天整理好 → 你在任何地方用 API 或网页看**。
没有常驻进程、不依赖局域网、月费零。

| 阶段 | 做什么 | 谁负责 |
|---|---|---|
| 采集 | 定时把 Apple Watch 数据 POST 上来 | iPhone HAE 自动化 |
| 入库 | 验签、按天聚合、单位换算、UPSERT | Worker |
| 存储 | 两张表，一天一格点 | D1 (SQLite) |
| 消费 | 时间序列查询 / 图表 / Agent 分析 | 查询 API、内置仪表盘 |

**分工要点**：聚合在**服务端**做，不在手机端做。原因见 [第 3.3 节](#33-聚合数据开关必须搞清的一个坑)。

---

## 1. 前置条件

| 项 | 要求 | 备注 |
|---|---|---|
| Cloudflare 账号 | 免费版即可 | 全程落在免费额度内 |
| Node.js | ≥ 18 | 用 `npx wrangler` |
| iPhone + Health Auto Export | 需 Premium（买断） | 采集端，必需 |
| **自己的域名** | 建议必备 | 见 [第 6.2 节](#62-workersdev-在大陆被污染) —— 用 `workers.dev` 默认域名在大陆大概率推不上来 |

---

## 2. Cloudflare 侧：六步部署

### 2.1 取代码

```bash
git clone https://github.com/hongyangchun/hae-api.git
cd hae-api
```

### 2.2 登录

```bash
npx wrangler login        # 浏览器点 Allow
```

### 2.3 建 D1 数据库

```bash
npx wrangler d1 create hae-health
```

输出里有一行 `database_id = "xxxxxxxx-xxxx-..."`，**复制下来**，下一步要用。

### 2.4 写 `wrangler.toml`

```bash
cp wrangler.example.toml wrangler.toml
```

然后编辑，填两个值：

```toml
name = "hae-api"
main = "src/worker.js"
compatibility_date = "2025-08-01"

routes = [
  { pattern = "你的域名.com", custom_domain = true }   # ← 换成你自己的域名
]

[[d1_databases]]
binding = "DB"
database_name = "hae-health"
database_id = "上一步拿到的 database_id"              # ← 换成你自己的
```

> [!IMPORTANT]
> **两个坑**
> 1. **仓库里的 `wrangler.toml` 是原作者的实例配置**（含其 `database_id` 与域名）。直接 `wrangler deploy` 会部署到你账号但路由绑到人家域名上。**务必按上面替换这两处。**
> 2. **`routes` 必须写在 `[[d1_databases]]` 之前**。TOML 的表归属规则：一旦出现 `[[d1_databases]]`，后面所有裸键都归它，`routes` 会变成 D1 的属性而被忽略。

`custom_domain = true` 要求该域名已托管在同一个 Cloudflare 账号下（免费套餐即可）。不想用自定义域名就整段删掉 `routes`，用默认的 `<name>.<子域>.workers.dev`。

### 2.5 建表

```bash
npx wrangler d1 execute hae-health --remote --file=schema.sql
```

建两张表（`metric_points` / `workouts`）和两个索引。可重复执行，`CREATE TABLE IF NOT EXISTS` 幂等。

### 2.6 配三个密钥

密钥**不走配置文件**，走 `wrangler secret`（加密存在 Cloudflare 侧）。

```bash
# 先生成三个随机串（各跑一次，复制结果）
openssl rand -hex 24

# 逐个写入
npx wrangler secret put WRITE_KEY    # ① 手机上传凭证
npx wrangler secret put READ_KEY     # ② 查询凭证
npx wrangler secret put DASH_TOKEN   # ③ 仪表盘口令
```

| 密钥 | 用途 | 谁能看到 |
|---|---|---|
| `WRITE_KEY` | `POST /api/data` 的校验，**只给 iPhone** | 只应存在于 iPhone 配置里 |
| `READ_KEY` | `/api/metrics`、`/api/query`、`/api/workouts` 的校验 | 查询方（脚本 / Agent / Grafana） |
| `DASH_TOKEN` | 仪表盘门禁，同时也是登录页口令（一物两用） | 你本人 |

> [!TIP]
> 把这三个值存进一个本地文件（如 `DEPLOY.local.md`），并**确认它被 `.gitignore` 覆盖**。
> 本仓库 `.gitignore` 已有 `*.local.md` 与 `keys.local.md` 两条规则。
>
> **`DASH_TOKEN` 建议用 6 位数字这类短口令**，不要用 48 位随机串 —— 手机上手输长串是灾难，而聊天窗口会把长串显示成 `sk-d-3…ffd2` 这种截断形式，从消息里复制会拿到残缺值。

### 2.7 部署

```bash
npx wrangler deploy
```

10 秒左右生效。Worker 名 `hae-api`，绑到你 `routes` 里写的域名。

### 2.8 冒烟测试

```bash
# ① 健康检查（公开端点，不需要密钥）
curl https://你的域名/
# 期待：{"ok":true,"service":"hae-api","time":"..."}

# ② 鉴权生效（不带密钥应被拒）
curl -o /dev/null -w "%{http_code}\n" https://你的域名/api/metrics
# 期待：401

# ③ 查询端点（带密钥，此时库还是空的）
curl -H "api-key: <READ_KEY>" https://你的域名/api/metrics
# 期待：[] 或空清单 —— 说明鉴权通过，数据还没进来
```

三步都对 = 服务端就绪。

---

## 3. iPhone Health Auto Export 配置

HAE → Automations → New Automation，**建两个**。

### 3.1 自动化 A：健康指标

| 配置项 | 值 |
|---|---|
| Automation Type | REST API |
| URL | `https://你的域名/api/data` |
| Headers | `api-key` = **WRITE_KEY** |
| Data Type | Health Metrics |
| Export Format | **JSON** |
| Aggregate Data | **开** |
| Aggregate Interval | **Days** |
| Batch Requests | 开 |
| 同步频率 | 每 5 分钟（或按需） |

### 3.2 自动化 B：锻炼记录

同上，唯一区别：**Data Type 选 Workouts**（聚合开关对锻炼无意义）。

### 3.3 「聚合数据」开关：必须搞清的一个坑

这是本项目**唯一容易踩死的地方**，而且历史文档里有过互相矛盾的结论，这里一次说清。

**开关语义**：打开后 HAE 每天只发 1 个点（日汇总）；关闭则发原始分段（一天几十个点）。

**两边诉求是相反的**：

| 数据 | 关闭聚合 | 打开聚合 |
|---|---|---|
| 累计型（步数、热量、距离） | 服务端自己求和 ✅ | 每天 1 点，服务端求和 = 原值 ✅ **不会算错** |
| 睡眠 | v10 会发**分段碎片**（`start/end/value`），服务端**拒收** ❌ 数据缺失 | 发完整汇总（total/deep/rem/core）✅ 正常入库 |

**推荐：打开聚合（Aggregate Interval = Days）。**

理由：
1. 睡眠碎片会被服务端的准入门禁丢掉（`worker.js` 的 `SLEEP_SUMMARY_KEYS` / `skipSleepMetric` 判定），导致睡眠数据整段缺失 —— 这是硬伤，不可接受。
2. 累计型指标在「每天 1 点」的形态下，服务端的求和操作是**恒等变换**（单点求和 = 自身），不会算错。

**为什么历史文档说要关闭**：早期 HAE 版本有一个 bug —— 开启按天聚合后，它把「日合计」错误地做成了「分段平均」，导致步数 9925 变成 16、活动热量 2970 kJ 变成 0.234 kJ。当时的结论是「关闭聚合、服务端自己算」。后来服务端加了按天聚合（`aggregateMetric()` 对累计型求和），这个 bug 的影响被吸收掉了，所以**当前推荐开启**。

> [!NOTE]
> 你可能会在 `POST /api/data` 的响应里见到这样的提醒：
> ```json
> {"ok":true,"metric_rows":42,"warnings":["「step_count」每天只有 1 个点：请在自动化里关闭 Aggregate Data（开启时累计型指标会被错误平均）"]}
> ```
> **这是遗留的误报**（`worker.js` 第 351 行的启发式判断），在「打开聚合」的推荐配置下必然触发。不影响数据正确性，可忽略。判断真实数据对不对，看下一节。

### 3.4 怎么验证数据是对的

推上数据后（等 5–10 分钟），查一次：

```bash
curl -H "api-key: <READ_KEY>" \
  "https://你的域名/api/query?name=step_count&from=2026-01-01&to=2026-12-31"
```

**合理的值**：几千到一两万（如 `9925.712`、`6704.05`）。
**被错误平均的值**：个位数或十几（如 `16.4`）—— 这才说明聚合链出了问题。

同样的量级自检：`active_energy` 应是几百到几千（kJ），`sleep_analysis.total` 应是 4–9（小时）。

### 3.5 历史数据回填

HAE → Export → 手动导出 JSON（**按月分段**选日期范围），逐个文件 POST：

```bash
curl -X POST -H "api-key: <WRITE_KEY>" -H "Content-Type: application/json" \
  --data-binary @HealthAutoExport-2026-08.json https://你的域名/api/data
```

- **重复推不会重**：写库是 `ON CONFLICT(metric,date,slot) DO UPDATE`（UPSERT），幂等。
- 当天还在累积的行，会随次日推送被覆盖为最终值 —— 正常现象，不必处理。
- 从 iCloud 导出的 JSON 直接 POST 也行，服务端兼容同源格式。

---

## 4. 仪表盘

`/dashboard` **内嵌在 Worker 里**（`src/dashboard.js`），随部署自动上线 —— 不需要单独托管、不需要额外域名、不需要独立仓库。

| 项 | 说明 |
|---|---|
| 访问 | `https://你的域名/dashboard` |
| 首次 | 访问 `/dashboard?t=<DASH_TOKEN>`，或在登录页手输口令 |
| 之后 | 下发 `dash=<HMAC 签名>` Cookie，**HttpOnly / Secure / 一年有效** |
| 内容 | 9 张图 + 6 个指标卡 + 锻炼记录表，支持 7/30/90/365 天切换 |
| 图表库 | ECharts 5.5.1（走 npmmirror CDN，国内可加载） |

**鉴权是两套独立体系**，别混淆：

| | 查询 API | 仪表盘 |
|---|---|---|
| 凭证 | `READ_KEY` | `DASH_TOKEN` |
| 传递方式 | 请求头 `api-key` | URL 参数 / 表单 → Cookie |
| 失效方式 | 重设 secret | 重设 secret（**所有设备立即重新登录**，等于一键全员下线） |

> [!TIP]
> `/dashboard` 页面里内联了 `READ_KEY` 供前端调 API。所以仪表盘的口令强度决定了 `READ_KEY` 的暴露程度 —— 别把 `DASH_TOKEN` 设得太好猜。

---

## 5. 验收清单

搭完逐项确认，全绿才算通：

- [ ] `curl https://你的域名/` → `{"ok":true,"service":"hae-api",...}`
- [ ] 不带 key 请求 `/api/metrics` → `401`
- [ ] 带 `READ_KEY` 请求 `/api/metrics` → 200，指标清单随时间增多
- [ ] `POST /api/data` 返回 `{"ok":true,"metric_rows":N,...}` 且 N > 0
- [ ] `step_count` 的值是**几千量级**（不是个位数）
- [ ] `sleep_analysis` 有 `total` 且值在 4–9 小时区间，`deep/rem/core` 非全零
- [ ] 浏览器打开 `/dashboard`，输口令后能看到图表
- [ ] iPhone 走动几百步后，等 5 分钟再查 `step_count`，今日值有增长

---

## 6. 排错速查

### 6.1 401 Unauthorized

九成是**密钥不对**：

- 复制时被截断（聊天窗口会把长串显示成 `sk-d-3…ffd2`）
- 粘贴时带上了首尾空格
- Header 名写错（是 `api-key`，不是 `Authorization`）

用 `pbcopy` 把完整 key 放进剪贴板再粘贴，别从聊天记录里复制。

### 6.2 `workers.dev` 在大陆被污染

用 Cloudflare 默认的 `<name>.<子域>.workers.dev` 域名，大陆手机**大概率推不上来**（DNS 污染）。

**解法**：绑自有域名（`routes` + `custom_domain = true`），免费。

### 6.3 403 Forbidden

不是密钥问题，是**请求被挡**：

- Python 脚本用默认 User-Agent 会被拦 → 加自定义 UA，如 `-H "User-Agent: hae-fetch/1.0"`
- 检查 Cloudflare 侧的 WAF / 防火墙规则

### 6.4 睡眠数据缺失或异常

| 现象 | 原因 |
|---|---|
| 完全查不到 `sleep_analysis` | 聚合开关被关，碎片被服务端拒收 → 打开聚合 |
| 某天 `total` 只有 1 小时出头且结构全零 | 手表没戴 / 没测到，不是链路问题 |
| 白天出现当日的睡眠点 | HAE 会推当日残夜点，仪表盘已过滤 `total > 1` |

**睡眠的日期语义**：日期 = **醒来那天早晨**。要查「昨晚睡得怎么样」，取**今天**日期的那条 `sleep_analysis`。

### 6.5 仪表盘图表空白 / 切换范围后错乱

图表重渲染前必须先 `dispose()` 旧实例并清空容器。这是 `dashboard.js` 已处理的点，自己改图表代码时注意别破坏。

### 6.6 Grafana「Save & Test」通过 ≠ 鉴权配置对

它测的是**公开**的 `/` 端点。`Save & Test` 绿了就以为配好了，实际查询会 401。要单独验证 `/api/query` 能返回数据。

---

## 7. 安全基线

| 规则 | 说明 |
|---|---|
| 密钥不入库 | `READ_KEY` / `WRITE_KEY` / `DASH_TOKEN` 只存 `wrangler secret` + 本地 `*.local.md` |
| `.gitignore` 必须覆盖 | 本仓库含 `keys.local.md`、`*.local.md` 两条规则 |
| `*.local.md` 权限 600 | `chmod 600 DEPLOY.local.md` |
| 提交前自检 | `git status` 里不该出现任何本地密钥文件 |
| 轮换很简单 | `npx wrangler secret put READ_KEY` 覆盖即可；`DASH_TOKEN` 覆盖后所有仪表盘 Cookie 立即失效 |
| 疑似泄露怎么办 | 三个一起换 —— 换完 iPhone 端要同步更新 `api-key`，否则推送 401 |

**泄露判定参考**：`database_id`、域名、Worker 名、`schema.sql` 都**不是**密钥（没有凭证访问不到 D1）。真正的密钥只有上面那三个。

---

## 8. 日常运维

```bash
# 改代码后重新部署（10 秒生效）
npx wrangler deploy

# 手动查数
curl -H "api-key: <READ_KEY>" "https://你的域名/api/query?name=step_count&from=2026-09-01"

# 直接看库里的表
npx wrangler d1 execute hae-health --remote --command "SELECT metric, COUNT(*) FROM metric_points GROUP BY metric"

# 看实时日志（排错用）
npx wrangler tail
```

**免费额度**（个人用量绰绰有余）：

| 资源 | 免费额度 | 实际占用 |
|---|---|---|
| Worker 请求 | 10 万次/天 | 每 5 分钟一次 ≈ 288 次/天 |
| D1 存储 | 5 GB | 按天数据一年仅几 MB |

---

## 9. 本地开发

```bash
# 用真实导出的 JSON 跑解析 + mock 入库，验证改动没破坏逻辑
node scripts/test_ingest.mjs

# 本地起 Worker 实测
npx wrangler dev
curl -X POST -H "api-key: <WRITE_KEY>" -H "Content-Type: application/json" \
  --data-binary @sample.json http://localhost:8787/api/data
```

**改代码的推荐流程**：本地 `test_ingest.mjs` 验证 → `wrangler dev` 实测 → `wrangler deploy`。

---

## 附：目录说明

```
.
├── src/
│   ├── worker.js        # 入口 + 路由 + 入库(handleIngest) + 查询(handleQuery/...)
│   └── dashboard.js     # 内嵌仪表盘（dashSig / loginHTML / dashboardHTML）
├── docs/
│   ├── deployment.md        # ← 本文
│   ├── link-contract.md     # 数据契约：字段、slot 语义、必守规则
│   ├── read-only-quickstart.md  # 只读接入极简版
│   └── design-notes.md      # 选型理由、原理、踩坑记录
├── schema.sql           # D1 表结构
├── wrangler.example.toml    # 配置模板（复制为 wrangler.toml 后填自己的值）
├── scripts/test_ingest.mjs  # 本地解析验证
├── TUTORIAL.md          # 精简版入门（五步搭建）
└── README.md            # 接口一览
```
