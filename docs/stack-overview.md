# HAE 健康栈总览

> 本文说明这套栈**由哪几块组成、各在哪、以及为什么这样划分**，兼作架构决策记录（ADR）。
> 部署步骤见 [deployment.md](./deployment.md)｜接口字段与 slot 语义见 [link-contract.md](./link-contract.md)｜选型原理与踩坑见 [design-notes.md](./design-notes.md)

---

## 1. 三块拼图

| 部分 | 仓库 / 位置 | 角色 | 状态 |
| :--- | :--- | :--- | :--- |
| **服务端** | `hongyangchun/hae-api` | 收数、按天聚合、查询 API、内置仪表盘 | ✅ 现役 |
| **展示端** | `hongyangchun/hae-pulse` | 菜单栏 / 顶栏小组件（Omarchy + macOS 双端） | ✅ 现役 |
| **一代方案** | 本地归档包 `health-os-legacy-*.tar.gz` | 走 Queues + R2 的重型管线，从未产生有效数据 | 📦 已归档 |

三者是**并列的三块**，不是「一个仓库的三层」：`hae-pulse` 与 `/dashboard` 是**平级的两个消费出口**，都只通过 HTTP 契约（`/api/query` + `api-key` 头）读服务端，**没有一行代码共享**。

依赖方向单向：展示端按契约调用服务端，仅此而已。

---

## 2. 数据流

```
采集   iPhone Health Auto Export（REST 自动化）
         │  POST /api/data          header: api-key = WRITE_KEY
         ▼
服务   Cloudflare Worker   hae-api
存储   Cloudflare D1       hae-health
         │  GET /api/query · /api/metrics · /api/workouts   header: api-key = READ_KEY
         ▼
展示   /dashboard（本仓库内嵌）·  hae-pulse 菜单栏  ·  自建脚本 / Agent
```

---

## 3. 仪表盘的归属

线上 `hae.qiaclass.com/dashboard` **既不是独立仓库，也不是独立托管的前端** —— 它与 Worker 同源，代码在本仓库 `src/dashboard.js`（139 行），随 Worker 一起部署。

| 组成 | 作用 |
| :--- | :--- |
| `dashSig(env)` | `HMAC-SHA256(DASH_TOKEN, 'dash-cookie-v1')` 生成 Cookie 签名 |
| `loginHTML(msg)` | 口令登录页 |
| `dashboardHTML(readKey)` | 仪表盘本体：ECharts + 多图 + 指标卡 + 锻炼表 + 7/30/90/365 天切换 |

鉴权：带 `?t=<DASH_TOKEN>` 访问一次，即下发 `dash=<HMAC 签名>` Cookie（HttpOnly / Secure，一年）。

**它留在服务端仓库，不搬进展示端。** 三条理由：

1. **认证耦合** —— 它依赖两个 Worker secret：`DASH_TOKEN`（签 Cookie）与 `READ_KEY`（内联进页面供前端调 API）。搬出去必须重建认证、配 CORS、多一个部署目标。
2. **层级并列，非从属** —— 它是服务端的浏览器出口，与端侧常驻插件平级。展示端菜单里的「打开仪表盘」只是链接过去。
3. **收益为零** —— 仪表盘迭代频率极低，改它本就是顺手改 Worker。

> 历史教训：这份代码原先混在 600 余行的 `worker.js` 中，而 README 的接口表漏列 `/dashboard` —— 结果是「仪表盘到底在哪」成了一个反复出现的疑问。现已拆分为独立文件并在 README 中显式声明。

---

## 4. 两代实现的关系

一代 `health_os`（Worker 名）已被二代 `hae-api` 取代。

**取代的原因很实在**：一代跑在 `health-os.<account>.workers.dev`，而 `workers.dev` 域名在大陆被 DNS 污染，iPhone 直连大概率失败 —— 它**从头到尾没接到过一条真实数据**。二代改用自有域名才打通。

| | 一代 `health_os` | 二代 `hae-api` |
| :--- | :--- | :--- |
| 形态 | monorepo：Worker + Assets / React + Vite + ECharts 前端 / R2 + Queue 管线 | 单 Worker：`src/worker.js` + `src/dashboard.js` |
| 鉴权 | `INGEST_TOKEN`(Bearer) / `DASH_PASSWORD` + Cookie | `WRITE_KEY` / `READ_KEY` / `DASH_TOKEN`，统一走 `api-key` 头 |
| 入口路由 | `/v1/ingest?target=…` | `/api/data`、`/api/query`、`/api/workouts`、`/api/metrics`、`/dashboard` |
| D1 数据 | `health-db` **0 行** | `hae-health` **有数据，持续写入** |
| 版本控制 | ❌ 从未入库 | ✓ 与 GitHub 同步 |

一代不是失败品，是一份**被网络现实否决的更完整的尝试**（含 React + ECharts 看板、R2 + Queue 异步归一化管线、完整 PRD/架构/QA 文档）。它作为本地归档包保留，是这套栈中**唯一记录「异步归一化」路线的实物**。

> **澄清一个常见误记**：GitHub 上**从来没有**名为 `health_os` / `health-os` / `Health-Assistant` 的仓库（三个名字均未被占用）。被删除的是 **Cloudflare 上的 Worker `health-os`** —— 误删的对象是运行时，不是代码仓库，且没有数据丢失（一代 D1 始终 0 行）。

---

## 5. 关键决策

| # | 决策 | 理由 |
| :- | :--- | :--- |
| 1 | 保持**两个仓库**，不合并 | 发布节奏不同（服务端 `wrangler deploy` 十秒生效；客户端要跑 `install.sh`）；且展示端有「clone 下来就能用」的独立分发价值，绑上私有服务端就失去它 |
| 2 | **仪表盘不搬进展示端** | 见第 3 节 |
| 3 | 一代**归档而非删除** | 打包为单文件归档（可随时完整克隆回来），原目录进废纸篓，全程可逆 |
| 4 | `wrangler.toml` **纳入版本控制** | 见下方 |
| 5 | 仓库名与 Worker 名、`/healthz` 返回的 service 名**三者对齐** | 消掉名词不统一，减少「这个仓库是干什么的」的反复困惑 |

### 关于 `wrangler.toml` 与密钥的边界

- **`wrangler.toml` 应当入库。** 它的两个值都不是密钥：`database_id` 泄露无害（没有 Cloudflare 凭证访问不到 D1），自定义域是公开的 DNS 记录。把它们排除在版本控制外，换来的是**单点故障** —— 本地副本一旦丢失，数据虽然还在 D1 里，却无法重新部署接上去。
- **`keys.local.md`（及一切 `*.local.md`）必须永久 gitignore。** 它含 `READ_KEY` / `WRITE_KEY` / `DASH_TOKEN` 三个明文密钥。
- 真正的 secret 走 `npx wrangler secret put`，本就不落在文件里。

---

## 6. 不要做的事

- **不要把服务端合进展示端。** 见第 1 节与决策 1。
- **不要把 `/dashboard` 搬进展示端。** 见第 3 节。
- **不要提交任何 `*.local.md`。** 含明文密钥。
- **不要在聊天窗口里复制长密钥。** 界面会把长字符串截断（历史上出现过 `sk-d-3…ffd2` 这样的残缺值），用 `pbcopy` 走剪贴板。
- **不要用 `workers.dev` 域名对外。** 大陆被 DNS 污染，必须用自定义域。
- **不要误删同账户下的其他项目资源。** 删除 Cloudflare 资源前先 `npx wrangler d1 list` / `r2 bucket list` 核对归属。

---

## 7. 必须遵守的接口规则

以下五条是接入方最常踩的坑，完整契约见 [link-contract.md](./link-contract.md)：

1. 请求必须带**自定义 `User-Agent`**（Python 默认 UA 会被 403 拦截）
2. 鉴权走 **`api-key` 头**（不是 `Authorization`）
3. 能量默认 **kJ**，须加 `convert=kcal`；距离加 `convert=km`
4. 睡眠日期 = **醒来那天早晨**（查「昨晚」取今天的点；过滤 `total<1h` 的白天残夜点）
5. 日期按 **`Asia/Shanghai`** 归天

### iPhone HAE 侧

**「汇总数据 / Aggregate Data」开关必须开启**（Aggregate Interval = Days），开启后由服务端 `aggregateMetric()` 按天正确求和。

> 这条结论有过一次反转，值得记录：早期版本的 HAE 在开启聚合后会把「日合计」错误地做成分段平均（实测步程 4.1 km/天只推来 0.016 km），当时的正确做法是关闭。后来服务端补上按天聚合后该问题被吸收 —— 而**关闭**聚合反而会让 v10 的睡眠数据退化成碎片、被服务端准入门禁拒收，导致睡眠整段缺失。因此当前正确配置是**开启**。
>
> 相应地，`POST /api/data` 响应中形如「每天只有 1 个点：请在自动化里关闭 Aggregate Data」的 `warnings` 属于历史误报，**已移除**（`warnings` 字段保留为空数组以维持响应兼容）。

### 服务端聚合规则

| 类型 | 规则 |
| :--- | :--- |
| 累计型（`SUM_METRICS` 名单） | 当天全分段**求和** |
| `heart_rate` | avg 取均值、min 取最小、max 取最大 |
| `sleep_analysis` | 直取当日值 |
| 其余瞬时型 | 当天各分段**平均** |
