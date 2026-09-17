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

### 2. 服务端正确聚合（本项目最大的坑，见第六节）
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
  slot: qty=普通（含 resting_heart_rate / heart_rate_variability / walking_heart_rate_average）
        | avg/min/max=仅 heart_rate
        | total/deep/rem/core/unclassified/awake/inbed=睡眠
workouts(id, name, day, start, end, duration_min, kcal, distance, avg_hr, max_hr, raw)
```

**两条槽位不变量**（都曾因违反而出过"数据缺失"的假象，见第六节 10、11）：

1. `avg/min/max` 三槽**只有** `heart_rate` 使用。名字里含 `heart_rate` 的其它指标
   （`resting_heart_rate` / `heart_rate_variability` / `walking_heart_rate_average`）
   每天只有一个标量，必须统一写 `qty`。判断规则收敛在 `isHrAggregate()` 一个函数里。
2. 睡眠的 `total = deep + rem + core + unclassified`。`unclassified` 是 Apple 的
   `asleepUnspecified`（手表没分成浅/深/REM 的那部分睡眠），必须单独成槽，
   否则堆叠图永远画不满总时长。

**不是所有指标都落库**。依赖滚动窗口、每来一条新数据都要重算历史的指标，做成
**读时计算的派生指标**，走 `/api/query` 同一个入口但不写 `metric_points`
（目前只有一个：`vo2_max_est`，见下面第 6 节）。好处是仪表盘和 pulse 插件共用
一份算法，不会两端各写一套然后慢慢漂移。

### 5. 查询 API
| 端点 | 用途 |
|---|---|
| `GET /` | 健康检查（公开，可用作存活监控） |
| `GET /api/metrics` | 指标清单（名称/单位/覆盖日期范围/点数）**不含派生指标** |
| `GET /api/query?name=X&from=&to=&convert=` | 某指标的时间序列 |
| `GET /api/query?name=vo2_max_est[&hrmax=]` | 心肺耐力估算（派生，不落库） |
| `GET /api/workouts?from=&to=` | 锻炼记录 |
| `POST /api/data` | HAE 推送入口（`preaggregated:true` 支持 Mac 本地预聚合回填） |

### 6. 心肺耐力（VO2max）估算

**为什么需要估算**：Apple Watch 只在「户外步行 / 户外跑步」且带 GPS 心率时才估
Cardio Fitness，而这个账号的锻炼全是力量训练 / 高强度间歇 / 骑行 —— 所以
`/api/query?name=vo2_max` 实测**永远返回空数组**（D1 里零行）。`vo2_max_est`
按 Uth–Sørensen–Overgaard 公式回退估算：

```
VO2max ≈ 15 × HRmax / HRrest        （mL/kg/min）
```

**两个输入的取法是关键**，直接决定结果能不能用：

| 输入 | 取法 | 为什么 |
|---|---|---|
| HRmax | 滚动 90 天窗口内，`heart_rate.max` 与 `workouts.max_hr` 的**较大值** | 最大心率在数月尺度上是个常数。若拿**当天**最大值去算，实测当天区间是 64~176，会得到 18~49 的垃圾序列 |
| HRrest | 静息心率的 **7 日滚动均值** | 静息心率本身噪声大（实测 52~66） |

返回体带上 `hrmax_ref` / `hrmax_source` / 每天的 `rhr7`、`rhr_n`，让界面能解释
这个数是怎么来的。可用 `?hrmax=185` 覆盖参考值（知道自己真实最大心率时）。

守卫（任一条不满足就返回空序列 + `reason`，绝不硬凑）：
- `hrmax_ref` 必须 ≥ 120 —— 否则说明近期没有接近力竭的记录，估算无意义；
- 静息心率整体样本 ≥ 5 天；
- 单日均线窗口至少 3 天 —— 数据开头几天不够就跳过该天，否则用 1~2 个点算出的
  均线会在图上拖出一条**假的下坡**。

**必须知道的局限**：
- 个体误差约 ±10~15%，**只看趋势和量级**，不能当体检结论；
- 按公式它本质是静息心率的单调变换（`15×HRmax/HRrest`，HRmax 是常数），所以它和
  静息心率曲线是**镜像共线**的。它的增量价值在于：① 绝对值 + 同龄段参考带让数字
  可解读，② 趋势方向符合直觉（涨=变好，而静息心率是跌=变好）；
- 同龄段参考带（Cooper Institute / ACSM 第 11 版 Table 4.7 男性百分位带）只用于
  **画参考线和标等级**，不参与任何计算；年龄段在 `dashboard.js` 顶部的 `PROF` 一行改。
  实现要点：`BANDS` 的四个阈值是**各档起始值**（ACSM 原表写作「上一档到 x.y、下一档
  从 x.y+0.1 起」，取值时别抄成上一档的结束值，否则整条参考带会低 0.1）；ACSM 原表
  是 Poor/Fair/Average/Good/Excellent/Superior 六档，这里把最顶上的 Superior
  （40-49 岁为 ≥55.6，竞技运动员区间）并进了「优秀」；年龄段按十位归档
  （`Math.floor(age/10)*10`），所以 40~49 岁都用 `BANDS[40]`。
  当前配置：男 44 岁 → 40-49 档 → 阈值 `[30.2, 35.4, 40.7, 47.4]`。


## 四、界面规范（三端共用）

三端 = `/dashboard`（网页）· SwiftBar 下拉（macOS）· Quickshell 弹层（Omarchy）。
**只有一份数据源，却有三个渲染面**（`dashboard.js` / `macos/render.py` /
`omarchy/hyc.hae-pulse/Main.qml`）。规范必须写下来，否则每改一次都要逐个端对齐 ——
2026-09-17 评审实测出 6 处漂移（行序、语言、对齐策略、主题、列宽、能力），
同日复查又出 3 处（首屏重复、macOS 双面板、日结型指标取不到当天值）。

### 1. 三层信息架构 —— 宽度决定层数，不改变结构

| 层 | 内容 | 菜单栏 | 下拉 | 弹层 | 仪表盘 |
|---|---|---|---|---|---|
| L1 结论 | 一句话结论 + 语义色 | ✓（一个数字） | ✓ | ✓ | ✓ 状态条 |
| L2 关键量 | 值 · 7 日基准 · 趋势 | — | ✓ 6 行 | ✓ | ✓ 8 张卡 |
| L3 明细 | 图表 / 记录 / 历史 | — | 训练记录 | ✓ | ✓ 分组图表 |

**「结论层」是最容易漏的一层**：插件一直有 `verdict`，而屏幕最大、信息最全的仪表盘反而没有，
层级是倒置的。现在仪表盘首屏就是状态条。

**但 L1 只放结论，不放数值。** 状态条曾经并列 HRV / 静息心率 / 睡眠 三格 —— 那是 L2 前三张卡的
**真子集**（卡片还多出趋势线和基准绝对值），两处相隔 16px、信息零增量，纯粹是重复。已移除。
结论句自己带了 HRV 的偏离幅度，那是 `verdictOf()` 判定的**直接依据**，够用。

### 2. 行序（三端必须一致）

```
HRV → 静息心率 → 心肺耐力(估) → 睡眠 → 体重 → 锻炼
```

有过一次漂移：macOS 把心肺耐力排在睡眠**前**、Omarchy 排在体重**后**，同一天两个平台看到的
信息顺序不同。**改一端的顺序必须同时改另外两端。**

### 3. 语言：统一中文，只保留单位缩写

英文词语全部译中（`READY`→`可以练`、`7d base`→`7 日均`、`TRAINING`→`训练`）。
**保留的是度量单位**：`ms / bpm / kg / kcal / ml/kg / h m` —— 它们在中文语境里也是标准写法。
`verdict` 的取值 `ready/watch/rest` 保持英文，那是数据标识不是文案。

### 4. 排版 token

| 项 | 值 |
|---|---|
| 字号 | 24 卡片数值 / 15 次强调 / 13 标题 / 12 正文 / 11 辅助（轴标签也用 11，不再是 10） |
| 间距 | 只用 4 / 8 / 12 / 16 / 24 |
| 字体 | 界面用系统 sans（`-apple-system, PingFang SC`）；**只有数据用等宽** —— 整个面板都用等宽会让中文变方块感 |
| 列宽 | 标签 106px / 值 112px（下拉与弹层共用同一组数，不再各写一个） |

下拉是等宽菜单，中文按 2 格计（`dwidth()`）。两条硬要求：

1. **列宽必须先收集所有行再统一算** `max(下限, 最长内容 + 2)`。逐行各自 `pad()` 会让
   「心肺耐力(估)」这种更宽的标签把整行顶歪。
2. `+2` 不是装饰：`pad()` 在内容恰好占满列宽时留 0 个空格，历史上出现过
   `Exercise  65 / 30 min585.1 kcal` 这种两列粘连的读数。

### 5. 颜色语义（同一颜色在三端只能有一种含义）

| 语义 | 色值 | 用在哪 |
|---|---|---|
| 好 / 对我有利 | `#3fb950` | 达标、优于基准 |
| 注意 / 偏离基准 | `#d29922` | |
| 危险 / 异常 | `#f85149` | **仅**越界。心率 `max` 用它 |
| 数据系列 | 步数 `#58a6ff` · 热量 `#f0883e` · 距离 `#7ee787` · HRV `#39d2c0` · 静息心率 `#3fb950` · 体重 `#d29922` · 血氧 `#bc8cff` | 跨指标不复用同色 |

两处曾经语义错位、已修：

- **静息心率原来是危险红**。静息心率下降是好事，用红表达一条健康趋势语义是反的，
  而且和「心率 max」同色。现在用绿 ——「越低越好」的指标用绿色系。
- **蓝色被复用了三次**（步数 / 血氧 / 睡眠核心）。跨指标同色会让人误以为它们相关，血氧已改紫。

**Δ 的箭头颜色按「指标方向」而非箭头方向**：HRV 越高越好（▲ 是绿），静息心率越低越好（▲ 是琥珀）。
同一个 ▲ 在不同卡片上异色是有意的。

睡眠结构用**同色相明度阶梯**（深睡 `#1f6feb` → REM `#388bfd` → 核心 `#58a6ff`）——
睡眠分期是**有序分类**，不该用几个互不相干的色相；「未分期」用**斜线纹理**而不是深灰实心
（旧 `#4d5566` 对卡片底 `#161b22` 只有 **2.31:1**，不达 WCAG 非文本图形成分要求的 3:1；
纹理同时解决对比度、「未知/待定」的通用视觉语汇、以及少一个色相造成的拼盘感）。

### 6. 三态：加载 / 空 / 失败 —— 失败必须与空态在视觉上分明

旧版 `load()` 的 `.catch` 直接返回空数组，于是 **401 / 网络故障 / CORS 出错最终都渲染成「暂无数据」**。
健康面板最不能容忍静默失败。现在：

- 加载中 → 骨架条（不用转圈，避免布局跳动）
- 空 → 「这段时间没有数据」
- 失败 → 「取数失败：<原因>」+ 重试按钮

### 7. 口径一致性（比好看重要）

- **睡眠图柱高 = 睡眠时长，与卡片同口径**。「清醒」段已从堆叠里移出 —— 旧版柱高含清醒 ≈ 在床时间，
  比卡片数字高，看起来像数据错了（其实是口径不一致）。
- **「取不到」与「真的没有」要能分辨**：09-13 无睡眠是**源端**当晚没记录（iCloud 明文导出里同样
  没有 `sleep_analysis`），不是服务端丢弃 —— 不要照着「修」。
- 仪表盘的 verdict 阈值与 `collector.py` 共用一套口径（今日 HRV 对比前 7 日均值：≥-5% 可以练 /
  ≥-15% 悠着点 / 更低该休息）。**两处实现、一处定义，改阈值要同时改。**
- **「锻炼」= 今日已记录的训练时长**（来自 `/api/workouts`），不是 Apple 锻炼环。
  锻炼环（`apple_exercise_time`）是日结型，当天的值在源端不存在，拿它算「今日锻炼」会恒为 0。
  代价：训练时长是锻炼环的子集，不计入非训练的零星活动分钟 —— 所以它叫「锻炼」不叫「活动」。
- **今日训练时长不跟基准比**：清早还没训练时 Δ 会是 −100%，那是「今天刚开始」不是「退步」，
  做成红色箭头会误导。锻炼卡片给的是「近 7 天 N 次 · M 分钟」，不是 Δ。

### 8. 数据日期必须标出来（日结型指标的坑）

**指标分两类，取值口径必须区别对待**（2026-09-17 用 `/api/metrics` 的 `first_day`/`last_day` 分组实测）：

| 类型 | 当天的点什么时候有 | 指标 |
|---|---|---|
| 实时型 | 当天随时 | `heart_rate`、`heart_rate_variability`、`step_count`、`active_energy`、`blood_oxygen_saturation`、`walking_running_distance`、`basal_energy_burned` … |
| **日结型** | **当天清晨才有** | `resting_heart_rate`、`sleep_analysis`、`weight_body_mass`、`apple_exercise_time`、`walking_speed`、`respiratory_rate`、`flights_climbed` … |

日结型由**整夜**的数据算出，Apple 清晨才定稿。所以「当天的点」不是不存在，而是**来得晚** ——
这一点很容易讲错，我们第一版就写错了：**把它当成「当天的点结构性不存在」**（依据是 09-16 那天查
`resting_heart_rate` 发现 `last_day` 停在 09-16，当天没有）。第二天早上再查，`last_day` 已经是 09-17、
值是 58 —— 当天的点照样会出现。两种状态都真实存在，取决于你什么时候查：

```
09-16 查 resting_heart_rate → last_day = 09-16（当天无点）→ 插件显示 —   ← 用户报的就是这个
09-17 查 resting_heart_rate → last_day = 09-17、值 58（清晨已落库）→ 正常显示
```

**结论：口径写死成「永远取今天」或「永远取昨天」都是错的，只能「取最后一个非空值 + 按日期判断要不要标」。**
两个后果：

1. **取数取「最后一个非空值」**，不能只取今天。`collector.py` 的 `latest()` 与 `dashboard.js` 的
   `stat()` 都这么做 —— 仪表盘一直显示正常正因为它这么做，而插件曾经只取今天，
   于是在清晨前静息心率恒为 `—`、锻炼恒为 0。
2. **值不是今天的才标数据日期**（` · MM-DD`），是今天的就不标（标了是冗余）。三端同一规则：
   `render.py` 的 `day_suffix()` / `Main.qml` 的 `daySuffix()` / `dashboard.js` 里比 `s.day` 与 `TODAY`。
   不标的话，昨天的读数会被当成今天的 —— 这是健康面板最不能出的一类错。
   HRV 是例外：它取不到今天时走「昨日 X ms」文案，不在日期后缀这套里。

顺带：`vo2_max_est` 是服务端派生指标，但它的输入是静息心率的 7 日滚动窗口，**因此继承了同样的滞后**。

排查入口：`/api/metrics` 的 `last_day` 是判断「源端到底有没有这个点」最快的一招 ——
一眼看出是取数口径的问题还是源端真没数据。**但它是会每天变化的，不能当固定属性背下来。**

### 9. 一个信息面就够，别做第二个

macOS 曾经有两个信息面：SwiftBar 下拉 + 一个 `panel.html` 的 webview 弹层。两者内容**完全重复**
（hero / sparkline / 生命体征行 / 训练表全都有），等于同一屏东西看两遍。Omarchy 端本来就只有
一个面（bar 只放数字，弹层放全部）。所以**面板整个删掉**，下拉就是那个弹层 ——
要更长的历史去网页仪表盘（下拉底部保留了入口）。**新增信息面之前先问：下拉真的放不下吗？**

**注意「信息面」和「文案面」不是一回事。** Omarchy 一个文件里其实有 4 份文案：bar 数字、
hover tooltip、popout 行、外加 macOS 下拉。删掉一层 UI 不等于只剩一份文案 ——
**文案面照样会各自漂移**。这次复查就发现 tooltip 漏了静息心率（用户报的正是「静息心率不显示」）、
行序与 popout 不同、且没走日期后缀与千分位。所以规则是：
**同一个量出现在几处，就有几处要改；行序、口径、日期规则、数字格式四样必须逐处对齐。**

### 10. 无障碍（实测，不靠感觉）

23 组前景/背景实测下来**只有 1 处不合格**（就是上面那个 2.31:1 的未分类色块），
所以**没有重做配色** —— 「看着有点灰」和「不达标」是两回事，先算再下结论。

已做的补全：标题层级不再跳级（`h1 → h2 分组 → h3 图表`）、图表容器加 `role="img"` + `aria-label`、
时间范围按钮加 `aria-pressed`、`table` 的 `th` 加 `scope="col"`、`:focus-visible`、
窄屏表格改卡片式（`data-l` + `::before`）、装饰性 emoji 加 `aria-hidden`。

> 反面提示：时间范围药丸高约 27.5px，**已满足 WCAG 2.5.8 的 24×24 目标尺寸**，
> 不需要为了「无障碍」放大到 44px —— 那是过度设计。



## 五、配置流程（可复现）

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
- 暗色主题、7/30/90/365 天切换、10 张图 + 7 个指标卡 + 锻炼表；ECharts 走 npmmirror 国内 CDN
- 换口令 = 改 DASH_TOKEN secret，所有设备 Cookie 立即失效重新登录（也是一键全员下线）

**B. Grafana Cloud（备用，已闲置）**
1. grafana.com 注册免费 stack → 装 Infinity 插件
2. 数据源：Base URL `https://hae.qiaclass.com`，Header `api-key`=READ_KEY，Allowed Hosts 加域名
3. Import `grafana-dashboard.json`（若 Infinity 版本差异导致空面板，用内置仪表盘即可）

**C. Agent 直读（真正的核心用途）**：直接问教练 Agent（如「我昨晚睡得怎么样」「这周练了几次」），它用 READ_KEY 查 /api/query 秒回分析；每天 08:00 早报也可挂云端周趋势。

## 六、踩坑记录（血泪经验）

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
10. **「静息心率缺失」其实是入库槽位分裂**（2026-09-16 修）：`metricRows()` 用 `includes('heart_rate')`、`aggregateMetric()` 用 `=== 'heart_rate'`，同一个指标被写成两个槽 —— 08-29~09-03 那批 Mac 回填数据写进 `avg`，之后 iPhone 推送写进 `qty`。仪表盘读 `avg` 于是只剩 6 天（卡在 09-03），pulse 插件读 `qty` 反而有 18 天。同一份真实数据跑两条路径即可复现。修法：判断规则收敛到 `isHrAggregate()`，存量 `avg` 行用 `scripts/migrate-2026-09-16-heart-rate-slots.sql` 并入 `qty`。
11. **「睡眠缺失」多数是 `unclassified` 被丢了**（2026-09-16 修）：`asleep` 字段以前只是 `totalSleep` 的兜底别名，于是 Apple 的「未分类睡眠」(asleepUnspecified) 从没入库。实测 2026-09-14 该字段为 0（当晚全部睡段都分类了），2026-09-10 则是 1.71h —— 差的正是堆叠图缺的那块。极端情况 09-01 整晚未分类（total 3.55 全在 unclassified），图表只剩一根 1.66h 的「清醒」柱，看起来像整晚没数据。**注意**：另有 09-13 整天无睡眠，那是源端当晚没有睡眠记录（iCloud 明文导出里同样没有 `sleep_analysis`），不是服务端丢弃 —— 不要照着"修"。
    修复代码只影响**新推来的数据**，历史天数得单独回填：
    `scripts/migrate-2026-09-16-sleep-unclassified.sql`（幂等，口径与 `sleepSlotValues()` 一致：
    `unclassified = max(0, total - (deep+rem+core))`。已执行，7 个槽位齐了）。为什么值得回填：
    否则「仪表盘前端现推」与「API 只返 6 槽」两边长期不一致，任何直接读 API 的消费方都对不上。
12. **`parseHaeDate()` 对 HAE 原生时间戳全部解析失败**（2026-09-16 修）：`"2026-09-13 23:24:43 +0800"` 只把日期与时间之间的空格换成 `T`，结果 `"…23:24:43 +08:00"` 里时区前仍有空格，V8 判为 Invalid Date。日期因为 `dayKey()` 还有正则兜底所以一直没错，但**所有基于时间戳的时长计算都是废的**（分段睡眠各阶段时长、锻炼 duration 兜底、在床时长）。修法：先把时区前的空格并掉再换 `T`。改完用 509 个真实时间字段做过回归，日期输出零漂移。
13. **`Number(null) === 0` 会把「没传参数」误判成「传了 0」**（2026-09-16 修）：`vo2_max_est` 里写成
    `numOrNull(Number(url.searchParams.get('hrmax')))` —— 参数缺失时 `get()` 返回 `null`，
    `Number(null)` 是**有限数 0**，于是被当成「用户指定 HRmax=0」，接着被 `<120` 守卫拒掉，
    **整个估算功能静默失效**（接口 200、返回空数组、不报错）。修法：先判空串/缺失再转换。
    教训：`searchParams` + `Number()` 组合必须显式处理 `null`，别指望 `isFinite` 兜住。
14. **把对象喂给 `fmt()` 会让卡片永远显示 `--`**（2026-09-16 修）：仪表盘睡眠卡片的
    `fmt(last(P.sleep).v != null ? ... : last(P.sleep,'total'), 1)` 少写了一个 `.v`，
    传进去的是 `{v, d}` 对象，`Number(对象)` = `NaN` → `fmt` 返回 `--`。因为**日期那一列是对的**
    （`last(...).d`），只坏了一个格子，很容易被当成"数据缺失"而不是"显示 bug"。
15. **仪表盘改完一定要真跑一遍渲染**（2026-09-16 起做法）：静态读代码发现不了 13/14 这类问题
    —— 两处都是「接口 200、页面不报错、就是没数」。做法：在 Node 里用桩 `document` / 桩 `echarts`
    （记得 `window.echarts`，脚本读的是 `window` 上的）+ 一个把相对路径补成绝对地址的 `fetch` 桩，
    跑真正的 `render()`，打印实际生成的卡片文案和 `setOption` 的 option。
    **已经固化成 `scripts/verify_dashboard_cards.mjs`**，直接跑就行，不要再一次性写：
    ```bash
    node scripts/verify_dashboard_cards.mjs          # 实时场景
    node scripts/verify_dashboard_cards.mjs wkfail   # 失败态
    DASH_HTML=/tmp/live_dash.html node scripts/...   # 验线上那份
    ```
    退出码分了 **0 通过 / 1 真的断言失败 / 2 不确定（网络丢请求）** —— 脚本内部记录
    「渲染期间哪些请求失败」来区分代码问题与网络抖动。**这一点很关键**：沙箱代理并发抓取时
    会随机丢请求，不分流的话每次红灯都要人肉判断，验几次就没人看了。
    **入口直接 `import { dashboardHTML }`，不要 curl 线上页面再正则抽脚本** ——
    本地就是源码真值，少一次网络、改完不必先部署就能验。
    而且**从源码验模板字符串里的转义会得出相反结论**（源码写 `\\B`，求值后才是 `\B`），
    要验正则必须验**求值之后**的那份脚本。
    另外两件必须一起做：**数请求条数**（曾漏调 `loadWorkouts()` 导致锻炼记录恒空，
    只有数条数才发现）和**线上/本地脚本逐字节对拍**（确认部署的确实是验过的那份）。
16. **日结型指标「当天的点来得晚」，不是「不存在」—— 这是本栈最容易反复踩的一类坑**（2026-09-17 修）：
    `resting_heart_rate` / `sleep_analysis` / `weight_body_mass` / `apple_exercise_time` 由整夜数据
    算出，Apple **清晨**才定稿。查的时点不同，看到的东西完全不同：09-16 查 `last_day` 停在 09-16
    （当天无点），09-17 早上查 `last_day` 已经是 09-17、值 58（已落库）。我们第一版把这段结论写成
    「当天的点在源端结构性不存在」，**这句话本身就成了下一个坑** —— 它会让后来的人（和写过的测试）
    认定「这些卡片必须永远带日期」，等清晨的点落库后反而误判成 bug。
    真正的后果是：仪表盘一直正常（`stat()` 取最后一个非空值），而 pulse 插件用 `rhr.get(str(TODAY))`
    在清晨前**恒定拿到 None，静息心率显示 `—`**；同口径的 `exercise_min_today = ex.get(t, 0)`
    让锻炼恒显示 `0 / 30 分钟`。同文件里 HRV 早就有 `hrv_yesterday` 回退，静息心率漏了
    —— **是不一致，不是数据问题**。
    修法：取「最后一个非空值」+ 把日期带出去 + 界面按日期决定标不标 ` · MM-DD`（见第四节 8）。
    排查入口是 `/api/metrics` 的 `last_day`，但**要记住它每天会变**，只能当「此刻源端有没有」的快照。


## 七、运维备忘

- **文件**：代码 `hae-api/`｜密钥与口令 `hae-api/keys.local.md`｜Grafana 备用面板 `hae-api/grafana-dashboard.json`
- **域名**：`hae.qiaclass.com`｜**仪表盘**：`/dashboard`（裸地址，口令见 keys.local.md）｜**D1**：hae-health (id b91ee90f-e928-497c-b15a-5d5cd7d5f59b)
- **改代码后**：`npx wrangler deploy`（10 秒生效）。本机仓库里另装了 wrangler 可直接用
  `node_modules/.bin/wrangler`（**未写进 package.json**，属本地便利工具，不影响 `npx` 路径）
- **手动查数**：`curl -H "api-key: <READ_KEY>" "https://hae.qiaclass.com/api/query?name=step_count"`
- **派生指标**：`curl -H "api-key: <READ_KEY>" "https://hae.qiaclass.com/api/query?name=vo2_max_est"`
  （带 `?hrmax=185` 可覆盖参考最大心率）
- **免费额度**：Worker 10 万请求/天、D1 5GB 存储（年度按天数据仅几 MB）——个人用量绰绰有余
- **与早报管线并行**：iCloud JSON → `parse_health_export.py` → 每天 08:00 简报，不受本方案影响
- **已知小缺口**：08-29 部分指标缺数据（HealthKit 当天来源问题，非链路问题）；今天的行在次日自动推送后覆盖为完整值
