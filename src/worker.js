/**
 * HAE API — Health Auto Export 的 Cloudflare 接收端
 *
 * 路由：
 *   POST /api/data                 iPhone HAE 推送（header: api-key = WRITE_KEY）
 *   GET  /                         健康检查（公开）
 *   GET  /api/metrics              指标清单           （header: api-key = READ_KEY）
 *   GET  /api/query?name=step_count&from=2026-01-01&to=2026-09-01
 *                                  指标时间序列       （header: api-key = READ_KEY）
 *   GET  /api/query?name=vo2_max_est[&hrmax=185]
 *                                  心肺耐力估算（派生，不落库）  （header: api-key = READ_KEY）
 *   GET  /api/workouts?from=...&to=...  锻炼记录       （header: api-key = READ_KEY）
 *
 * 日期全部按 Asia/Shanghai 归到天，和 iPhone 上看到的一致。
 */

import { dashSig, loginHTML, dashboardHTML } from './dashboard.js';

const TZ = 'Asia/Shanghai';
/** kcal → kJ 的换算系数（1 kcal = 4.184 kJ）。方向提醒：**kJ / 4.184 = kcal**。
 *  旧名 KJ_TO_KCAL 与实际方向相反（KJ→kcal 应该是 0.239），很容易让后来人乘错方向；
 *  而健康数据里差 4 倍不会抛错，只会让热量看起来离谱。 */
const KJ_PER_KCAL = 4.184;

/* ---------- 日期工具 ---------- */

function parseHaeDate(v) {
  if (!v) return null;
  // "2026-09-02 00:00:00 +0800" -> "2026-09-02T00:00:00+08:00"
  // 注意：必须先把时区前的空格去掉。只把日期与时间之间的空格换成 T 会得到
  // "2026-09-02T00:00:00 +08:00"，V8 视为 Invalid Date —— 之前因此所有带时区
  // 的时间戳都解析失败（日期靠 dayKey 的正则兜底才没出错，但时长计算全废）。
  const s = String(v).trim()
    .replace(/\s+([+-]\d{2}):?(\d{2})$/, '$1:$2')
    .replace(' ', 'T');
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const shanghaiDay = (d) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);

function dayKey(v) {
  const d = parseHaeDate(v);
  if (d) return shanghaiDay(d);
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null; // 已是 YYYY-MM-DD 的直接截取
}

const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** YYYY-MM-DD 加减天数。用 UTC 正午做锚点，避开夏令时/时区把日期推错一天。 */
function shiftDay(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/* ---------- 心肺耐力（VO2max）估算 ----------
 * Apple Watch 只在「户外步行 / 户外跑步」且带 GPS 心率时才估 Cardio Fitness，
 * 本账号的锻炼全是力量训练 / 高强度间歇 / 骑行，所以 Apple 侧 vo2_max 恒为空
 * （实测 metric_points 里 vo2_max 零行）。于是按 Uth–Sørensen–Overgaard 公式回退估算：
 *
 *     VO2max ≈ 15 × HRmax / HRrest          （单位 mL/kg/min）
 *
 * 这个公式的个体误差约 ±10~15%，只适合看趋势和量级，不适合当体检结论。
 *
 * 两个输入的取法（关键，直接决定结果是否可用）：
 *   HRmax   个人的「最大心率」在数月尺度上是常数，因此取一个滚动窗口内的实测最大
 *           心率，而不是当天最大值。当天心率区间波动极大（实测 64~176），拿当天
 *           最大值去算会得到 18~49 的垃圾序列。
 *   HRrest  静息心率本身噪声大（实测 52~66），取 7 日滚动均值。
 *
 * 该指标是「读时计算」的派生指标，不写 metric_points —— 因为它依赖滚动窗口，
 * 落库后每来一条新数据都要重算历史，得不偿失。仪表盘和 pulse 插件都查这一个
 * 接口，从而共用同一套算法。
 */
const VO2_HRMAX_WINDOW_DAYS = 90; // HRmax 参考值的回溯窗口
const VO2_HRMAX_MIN = 120;        // 低于此值说明从没真正发力过，估算无意义
const VO2_RHR_WINDOW_DAYS = 7;    // 静息心率平滑窗口（天）
const VO2_RHR_MIN_DAYS = 5;       // 静息心率整体样本下限
const VO2_RHR_MIN_WINDOW = 3;     // 单日均线的最少样本：数据开头几天不够就跳过该天，
                                  // 否则用 1~2 个点算出的均线会在图上拖出一条假的下坡

/** 用 Uth 公式估算心肺耐力。返回 /api/query 同构的响应体。 */
async function handleVo2MaxEst(url, env, from, to) {
  const meta = {
    derived: true,
    method: 'uth',
    formula: 'VO2max ≈ 15 × HRmax / HRrest',
    units: 'mL/kg/min',
    hrmax_window_days: VO2_HRMAX_WINDOW_DAYS,
    rhr_window_days: VO2_RHR_WINDOW_DAYS,
  };

  const winStart = shiftDay(to, -VO2_HRMAX_WINDOW_DAYS);
  // 注意：不能写成 numOrNull(Number(searchParams.get('hrmax'))) —— 参数缺失时
  // get() 返回 null，而 Number(null) === 0 是有限数，会被误判成「用户指定 HRmax=0」，
  // 接着被下面的 <120 守卫拒掉，整个估算功能静默失效。必须先判空串/缺失。
  const rawHrmax = url.searchParams.get('hrmax');
  const override = rawHrmax && Number.isFinite(Number(rawHrmax)) ? Number(rawHrmax) : null;

  let hrmaxRef = override;
  let hrmaxSource = override === null ? null : 'URL 指定 (?hrmax=)';
  if (hrmaxRef === null) {
    // 日聚合心率给的是全天最大；锻炼表里还可能有独立测得的最大心率。取两者较大值。
    const row = await env.DB.prepare(
      `SELECT MAX(m) AS m FROM (
         SELECT MAX(qty) AS m FROM metric_points
          WHERE metric = 'heart_rate' AND slot = 'max' AND date >= ?1 AND date <= ?2
         UNION ALL
         SELECT MAX(max_hr) AS m FROM workouts WHERE day >= ?1 AND day <= ?2
       )`,
    ).bind(winStart, to).first();
    hrmaxRef = numOrNull(row?.m);
    hrmaxSource = `实测最大值（${winStart} ~ ${to}）`;
  }

  if (hrmaxRef === null || hrmaxRef < VO2_HRMAX_MIN)
    return json({
      name: 'vo2_max_est', ...meta, hrmax_ref: hrmaxRef, hrmax_source: hrmaxSource,
      points: [],
      reason: `参考最大心率不足（${hrmaxRef ?? '无'} bpm < ${VO2_HRMAX_MIN}），近期没有接近力竭的运动记录，无法估算`,
    });

  // 静息心率多取 14 天，给 7 日滚动均值预热，避免区间开头几天均线偏高
  const { results } = await env.DB.prepare(
    `SELECT date, qty FROM metric_points
      WHERE metric = 'resting_heart_rate' AND slot = 'qty'
        AND date >= ?1 AND date <= ?2 ORDER BY date`,
  ).bind(shiftDay(from, -2 * VO2_RHR_WINDOW_DAYS), to).all();

  if (results.length < VO2_RHR_MIN_DAYS)
    return json({
      name: 'vo2_max_est', ...meta, hrmax_ref: hrmaxRef, hrmax_source: hrmaxSource,
      points: [],
      reason: `静息心率样本不足（${results.length} 天 < ${VO2_RHR_MIN_DAYS} 天）`,
    });

  const points = [];
  for (let i = 0; i < results.length; i++) {
    const date = results[i].date;
    if (date < from || date > to) continue;
    const win = results.slice(Math.max(0, i - VO2_RHR_WINDOW_DAYS + 1), i + 1);
    if (win.length < VO2_RHR_MIN_WINDOW) continue;
    const rhr7 = win.reduce((s, r) => s + r.qty, 0) / win.length;
    if (!rhr7) continue;
    points.push({
      date,
      qty: Math.round((15 * hrmaxRef / rhr7) * 10) / 10,
      rhr7: Math.round(rhr7 * 10) / 10, // 附上输入，便于界面解释这个数是怎么来的
      rhr_n: win.length,
    });
  }
  return json({ name: 'vo2_max_est', ...meta, hrmax_ref: hrmaxRef, hrmax_source: hrmaxSource, points });
}

/* D1 bind 只接受标量：新版 HAE 个别字段可能是对象，智能取值后 JSON 兑底 */
const scalar = (v, pick = []) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    for (const k of pick)
      if (v && typeof v === 'object' && v[k] !== null && v[k] !== undefined && typeof v[k] !== 'object')
        return String(v[k]);
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return v;
};

/** 指标名字段的候选键。metric.name 在新版 HAE 里可能是对象（如 {value:'Step Count'}），
 *  必须在**解析的源头**用 scalar 取出字符串 —— 否则会一路传到写入时被 JSON.stringify
 *  成 `{"value":"step_count"}` 这种指标名，等于往库里塞一个垃圾指标。 */
const NAME_PICK = ['name', 'metric', 'value', 'key', 'text'];
/** units 同理。曾漏掉 'value'，导致 units 被写成 `{"value":"count"}` 字符串 ——
 *  数值不受影响，但单位列变成一个 JSON 片段，任何按 units 分支的处理都会失灵。 */
const UNIT_PICK = ['units', 'key', 'symbol', 'value', 'text'];

/* ---------- 指标解析 ---------- */

// 累计型指标：一天的正确值 = 各分段之和（HAE 自带聚合会把它们错误地平均，所以必须在服务端求和）
const SUM_METRICS = new Set([
  'step_count', 'active_energy', 'basal_energy_burned',
  'walking_running_distance', 'cycling_distance', 'flights_climbed',
  'apple_exercise_time', 'apple_stand_time', 'apple_stand_hour',
  'time_in_daylight', 'dietary_water', 'mindful_minutes', 'handwashing',
]);

/* 睡眠槽位（汇总式睡眠点，单位小时）
 *   total        睡眠总时长（HAE 的 totalSleep，不含清醒）
 *   deep/rem/core 三类已分类睡眠
 *   unclassified Apple 的「未分类睡眠」(asleepUnspecified)
 *   awake/inbed  清醒、在床
 *
 * 为什么 unclassified 要单独成槽：它以前只作为 totalSleep 的兜底别名存在，
 * 于是「深睡+REM+核心」堆叠永远小于总时长，图表看起来像缺数据。
 * 实测 2026-09-14：totalSleep 6.4039 = deep 0.5829+rem 1.0659+core 4.7551，asleep = 0；
 * 而 2026-09-10：total 6.07 但分类仅 4.36 —— 差的 1.71 小时全在 unclassified 里被丢掉了。
 *
 * inbed 说明：HAE 的 inBed 字段实测恒为 0，真实在床时长要用 inBedEnd - inBedStart 补算。
 */
function sleepSlotValues(p) {
  const deep = numOrNull(p.deep), rem = numOrNull(p.rem), core = numOrNull(p.core);
  const awake = numOrNull(p.awake);
  const asleep = numOrNull(p.asleep); // Apple: asleepUnspecified

  let total = numOrNull(p.totalSleep);
  if (total === null) {
    const parts = [deep, rem, core, asleep].filter((v) => v !== null);
    total = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }

  // 优先用 Apple 给的 asleep；老数据/缺字段时用「总时长 - 已分类」推导
  let unclassified = asleep;
  if (unclassified === null && total !== null && (deep !== null || rem !== null || core !== null))
    unclassified = total - (deep || 0) - (rem || 0) - (core || 0);
  if (unclassified !== null) unclassified = Math.max(0, Math.round(unclassified * 1000) / 1000);

  // inBed 补算：HAE 的 inBed 字段实测恒为 0（真实在床时长要用 inBedEnd - inBedStart 算）。
  // **补算失败必须写 null，不能留 0** —— 「在床 0 小时」物理上不可能，写进去会让任何
  // 「睡眠效率 = total / inbed」的下游计算除零或得出 0%。线上因此有 16/19 天的 inbed
  // 是 0（09-15 起 HAE 才开始给真值）。
  let inbed = numOrNull(p.inBed);
  if (!inbed) {
    const s = parseHaeDate(p.inBedStart), e = parseHaeDate(p.inBedEnd);
    inbed = (s && e && e > s) ? Math.round(((e - s) / 3600000) * 1000) / 1000 : null;
  }

  return { total, deep, rem, core, awake, unclassified, inbed };
}

// 只有聚合心率 heart_rate 使用 avg/min/max 三槽；其余含 "heart_rate" 字样的指标
// （resting_heart_rate / heart_rate_variability / walking_heart_rate_average）都是
// 每天一个标量，必须统一写 'qty' 槽。曾因 metricRows 用 includes、aggregateMetric 用
// 全等，同一天被写成两个槽，仪表盘读 avg 只有 6 天数据、报表读 qty 有 19 天。
const isHrAggregate = (name) => name === 'heart_rate';

// 新版 HAE 分段式睡眠点：{start, end, value: "睡眠时长"|"核心"|"深度"|"快速眼动"|"清醒"...}
// value 是本地化字符串（中文/英文都可能），映射到库内 slot
function sleepStageSlot(stageRaw) {
  const k = String(stageRaw).toLowerCase();
  if (k.includes('deep') || k.includes('深度') || k.includes('深睡')) return 'deep';
  if (k.includes('core') || k.includes('核心')) return 'core';
  if (k.includes('眼动')) return 'rem';
  if (k.includes('awake') || k.includes('清醒')) return 'awake';
  if (k.includes('bed') || k.includes('床')) return 'inbed';
  return 'total'; // 睡眠时长/asleep/unspecified 等都算总时长
}

// 睡眠点日期：分段式取结束时间（醒来那天早晨），汇总式沿用 date/sleepStart
function sleepPointDate(p) {
  return dayKey(p.endDate || p.end || p.date || p.startDate || p.sleepStart);
}

/** 把一条 HAE metric 原样拆成数据行 { metric, date, slot, qty, units }。
 *
 *  ⚠️ **ingest 已不再走这里**（原因见 handleIngest 里 toRows 的注释）：它对同一天的
 *  多条不做聚合，靠主键冲突互相覆盖，只在"输入确实已是每天一行"时才对，而那个前提
 *  是客户端自报的、不可信。保留导出仅为了兼容外部调用方。 */
export function metricRows(metric) {
  const name = scalar(metric?.name, NAME_PICK) || 'unknown';
  const units = scalar(metric?.units, UNIT_PICK) || '';
  const rows = [];
  for (const p of Array.isArray(metric?.data) ? metric.data : []) {
    if (!p || typeof p !== 'object') continue;

    if (name === 'sleep_analysis') {
      const date = sleepPointDate(p);
      if (!date) continue;
      const stageRaw = typeof p.sleepStage === 'string' ? p.sleepStage : (typeof p.stage === 'string' ? p.stage : (typeof p.value === 'string' ? p.value : null));
      if (stageRaw) {
        const s = parseHaeDate(p.startDate || p.start || p.date);
        const e = parseHaeDate(p.endDate || p.end || p.date);
        const v = s && e ? (e - s) / 3600000 : numOrNull(p.qty);
        if (v !== null) rows.push({ metric: name, date, slot: sleepStageSlot(stageRaw), qty: Math.round(v * 1000) / 1000, units: units || 'hr' });
      } else {
        for (const [slot, v] of Object.entries(sleepSlotValues(p)))
          if (v !== null) rows.push({ metric: name, date, slot, qty: v, units: units || 'hr' });
      }
      continue;
    }

    const date = dayKey(p.date || p.startDate || p.sleepStart);
    if (!date) continue;

    if (isHrAggregate(name)) {
      // 小时统计点带 Avg/Min/Max；日聚合后同样适用
      const a = numOrNull(p.Avg), mi = numOrNull(p.Min), ma = numOrNull(p.Max), q = numOrNull(p.qty);
      const fallback = a ?? mi ?? ma ?? q; // 只有 qty 时也归到 avg，保持该指标的槽位语义
      if (a !== null) rows.push({ metric: name, date, slot: 'avg', qty: a, units });
      if (mi !== null) rows.push({ metric: name, date, slot: 'min', qty: mi, units });
      if (ma !== null) rows.push({ metric: name, date, slot: 'max', qty: ma, units });
      if (a === null && mi === null && ma === null && fallback !== null)
        rows.push({ metric: name, date, slot: 'avg', qty: fallback, units });
      continue;
    }

    const q = numOrNull(p.qty);
    if (q !== null) rows.push({ metric: name, date, slot: 'qty', qty: q, units });
  }
  return rows;
}

/** 把一条 metric 的原始分段聚合成"每天一行":
 *  累计型→求和；heart_rate(Avg/Min/Max)→均值/最小/最大；其余→平均；睡眠→直接取值 */
export function aggregateMetric(metric) {
  const name = scalar(metric?.name, NAME_PICK) || 'unknown';
  const units = scalar(metric?.units, UNIT_PICK) || '';
  const isSum = SUM_METRICS.has(name);
  const byDay = new Map(); // date -> { slots: Map<slot, {sum,count,min,max}> }
  for (const p of Array.isArray(metric?.data) ? metric.data : []) {
    if (!p || typeof p !== 'object') continue;

    if (name === 'sleep_analysis') {
      const date = sleepPointDate(p);
      if (!date) continue;
      let day = byDay.get(date);
      if (!day) { day = { slots: new Map() }; byDay.set(date, day); }
      const stageRaw = typeof p.sleepStage === 'string' ? p.sleepStage : (typeof p.stage === 'string' ? p.stage : (typeof p.value === 'string' ? p.value : null));
      if (stageRaw) {
        // 分段式：同晚多段累计求和
        const s = parseHaeDate(p.startDate || p.start || p.date);
        const e = parseHaeDate(p.endDate || p.end || p.date);
        const v = s && e ? (e - s) / 3600000 : numOrNull(p.qty);
        if (v !== null) {
          const slot = sleepStageSlot(stageRaw);
          const acc = day.slots.get(slot) || { sum: 0, count: 0, min: Infinity, max: -Infinity };
          acc.sum += v; acc.count++; acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v);
          day.slots.set(slot, acc);
        }
      } else {
        // 汇总式点（HAE 开「聚合数据」后的日常推送）：值本身已是当天合计，直接覆盖
        for (const [slot, v] of Object.entries(sleepSlotValues(p)))
          if (v !== null) day.slots.set(slot, { sum: v, count: 1, min: v, max: v });
      }
      continue;
    }

    const date = dayKey(p.date || p.startDate || p.sleepStart);
    if (!date) continue;
    let day = byDay.get(date);
    if (!day) { day = { slots: new Map() }; byDay.set(date, day); }

    if (isHrAggregate(name)) {
      const a = numOrNull(p.Avg), mi = numOrNull(p.Min), ma = numOrNull(p.Max);
      if (a === null && mi === null && ma === null) {
        // 只有 qty 的心率点（HAE 关掉聚合、或换了聚合粒度时发的形状）也必须落到 avg 槽。
        // metricRows 一直有这层 `a ?? mi ?? ma ?? q` 兜底，aggregateMetric 漏了 —— 一旦
        // HAE 改配置，心率会**整段静默消失**（实测输入 2 个点 → 输出 0 行），而不是降级。
        const q = numOrNull(p.qty);
        if (q !== null) {
          const acc = day.slots.get('avg') || { sum: 0, count: 0, min: Infinity, max: -Infinity };
          acc.sum += q; acc.count++; acc.min = Math.min(acc.min, q); acc.max = Math.max(acc.max, q);
          day.slots.set('avg', acc);
        }
        continue;
      }
      for (const [slot, v] of [['avg', a], ['min', mi], ['max', ma]]) {
        if (v === null) continue;
        const acc = day.slots.get(slot) || { sum: 0, count: 0, min: Infinity, max: -Infinity };
        acc.sum += v; acc.count++; acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v);
        day.slots.set(slot, acc);
      }
      continue;
    }

    const v = numOrNull(p.qty);
    if (v === null) continue;
    const acc = day.slots.get('qty') || { sum: 0, count: 0, min: Infinity, max: -Infinity };
    acc.sum += v; acc.count++; acc.min = Math.min(acc.min, v); acc.max = Math.max(acc.max, v);
    day.slots.set('qty', acc);
  }

  const rows = [];
  for (const [date, day] of byDay)
    for (const [slot, acc] of day.slots) {
      let qty;
      if (slot === 'min') qty = acc.min;
      else if (slot === 'max') qty = acc.max;
      else if (isSum) qty = acc.sum;
      else qty = acc.sum / acc.count;
      rows.push({ metric: name, date, slot, qty: Math.round(qty * 1000) / 1000, units });
    }
  return rows;
}

/* ---------- 锻炼解析 ---------- */

export function workoutRow(w) {
  const name = scalar(w?.name, ['value', 'text', 'key', 'name']) || 'Workout';
  const start = scalar(w?.start, ['date', 'dateTime', 'datetime']);
  const end = scalar(w?.end, ['date', 'dateTime', 'datetime']);
  const id = String(w?.id || `${name}|${start}`);

  let dur = numOrNull(w?.duration);
  const startD = parseHaeDate(start);
  const endD = parseHaeDate(end);
  if (dur === null && startD && endD) dur = (endD - startD) / 1000;

  // 能耗候选：activeEnergyBurned（HAE 给的一天总量）→ totalEnergy → activeEnergy。
  // **不能写成 `a || b || c`**：activeEnergy 是**逐分钟点的数组**（truthy），会让它
  // 短路掉后面的 totalEnergy 兜底，而 `energy?.qty` 在数组上取不到值 → kcal 静默变
  // null（实测一条锻炼的 totalEnergy 1669.9 kJ 就这样被丢掉了）。
  let kcal = null, energyUnits = null;
  for (const cand of [w?.activeEnergyBurned, w?.totalEnergy]) {
    const v = numOrNull(cand?.qty);
    if (v !== null) { kcal = v; energyUnits = cand?.units; break; }
  }
  if (kcal === null && Array.isArray(w?.activeEnergy)) {
    const sum = w.activeEnergy.reduce((a, p) => a + (numOrNull(p?.qty) ?? 0), 0);
    if (sum > 0) { kcal = sum; energyUnits = w.activeEnergy[0]?.units; }
  }
  if (kcal !== null && String(energyUnits || '').toLowerCase().startsWith('kj'))
    kcal = kcal / KJ_PER_KCAL;

  let avgHr = numOrNull(w?.avgHeartRate?.qty);
  let maxHr = numOrNull(w?.maxHeartRate?.qty);
  // 两处都必须可选链。maxHeartRate 那行曾经漏了 `?.`，于是「既无 maxHeartRate 又无
  // heartRate」的锻炼（App 里手动记录、或没戴表的那次）会让 workoutRow 抛异常 ——
  // 而它在整个 ingest 的 try 里，**一条坏锻炼会连带当天全部指标一起 500 丢掉**。
  // 线上没炸只是因为 HAE 目前每条都带 heartRate，属于侥幸。
  if (avgHr === null && w?.heartRate?.avg) avgHr = numOrNull(w.heartRate.avg.qty);
  if (maxHr === null && w?.heartRate?.max) maxHr = numOrNull(w.heartRate.max.qty);
  if (avgHr !== null) avgHr = Math.round(avgHr * 10) / 10;
  if (maxHr !== null) maxHr = Math.round(maxHr * 10) / 10;

  return {
    id, name, day: dayKey(start), start, end,
    // 取整到 1 位小数。HAE 的 duration 是浮点秒（如 3915.673400044441），不收敛就会把
    // 71.96487963199615 分钟、361.36192551290105 kcal 一路带进 DB 和 API 响应。
    // avg_hr/max_hr 早就 round 了，这两个漏掉属于同一函数内的不一致。
    duration_min: dur === null ? null : Math.round((dur / 60) * 10) / 10,
    kcal: kcal === null ? null : Math.round(kcal * 10) / 10,
    distance: numOrNull(w?.distance?.qty),
    distance_units: scalar(w?.distance?.units, UNIT_PICK),
    avg_hr: avgHr, max_hr: maxHr,
    source: scalar(w?.source, ['name', 'value', 'key', 'source']),
    raw: JSON.stringify(w),
  };
}

/* ---------- HTTP 工具 ---------- */

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/* ---------- 接收端 ---------- */

export async function handleIngest(request, env) {
  if (!env.WRITE_KEY || request.headers.get('api-key') !== env.WRITE_KEY)
    return json({ error: 'unauthorized' }, 401);

  const raw = await request.text(); // 先取原文再解析，便于对非法 JSON 返回 400
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ error: 'invalid json' }, 400); }
  try {
  const data = payload?.data ?? payload;
  const allMetrics = Array.isArray(data?.metrics) ? data.metrics : [];
  const workouts = Array.isArray(data?.workouts) ? data.workouts : [];
  // 睡眠数据准入规则：
  //   - 汇总格式（totalSleep/deep/rem/core 等键，旧格式或开「聚合数据」后的 REST）→ 收
  //   - 原始碎片（start/end/value 分段，v10 REST 未开聚合时发的，不全）→ 丢
  //   - 带 X-HAE-Source: icloud-json 的回填 → 全收
  const SLEEP_SUMMARY_KEYS = ['totalSleep', 'deep', 'rem', 'core', 'awake', 'inBed', 'asleep', 'inbed'];
  const isSleepBackfill = request.headers.get('x-hae-source') === 'icloud-json';
  const isSummarySleep = (m) => {
    const pts = Array.isArray(m?.data) ? m.data : [];
    return pts.some((p) => p && typeof p === 'object' && SLEEP_SUMMARY_KEYS.some((k) => k in p));
  };
  const isSegSleep = (m) => {
    const pts = Array.isArray(m?.data) ? m.data : [];
    return pts.some((p) => p && typeof p === 'object' && typeof p.value === 'string' && (p.start || p.startDate));
  };
  const skipSleepMetric = (m) => !isSleepBackfill && isSegSleep(m) && !isSummarySleep(m);
  const skippedSleep = allMetrics.filter((m) => String(m?.name) === 'sleep_analysis' && skipSleepMetric(m)).length;
  const metrics = allMetrics.filter((m) => String(m?.name) !== 'sleep_analysis' || !skipSleepMetric(m));

  const stmts = [];
  let metricRowCount = 0;
  // 曾经按 `data.preaggregated === true` 分流到 metricRows（原样逐条入库），已取消。
  // preaggregated 是**客户端自报**的，服务端全盘信任它太危险：一旦 Mac 端回填时误标
  // （把分段数据标成"已是每天一行"），metricRows 会让同一天的多条互相覆盖，静默丢数。
  // 拿 iCloud 真实导出文件实测：physical_effort 该 2.533 被写成 1（-60.5%）、
  // walking_speed 该 3.729 写成 2.448（-34.4%），单指标一次丢 63 个分段，接口仍返回 200。
  // aggregateMetric 对"一天一行"的输入结果完全等价（求和/平均退化成该值本身、睡眠
  // 汇总式点直接覆盖），所以统一走它 —— 保住正确性，同时消掉这条信任边界。
  const toRows = aggregateMetric;
  const METRIC_UPSERT = `INSERT INTO metric_points (metric, date, slot, qty, units)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(metric, date, slot) DO UPDATE SET qty = excluded.qty, units = excluded.units`;
  for (const m of metrics)
    for (const r of toRows(m)) {
      stmts.push(env.DB.prepare(METRIC_UPSERT).bind(
        scalar(r.metric, NAME_PICK), scalar(r.date, ['date', 'value', 'key']),
        scalar(r.slot, ['slot', 'value', 'key']), scalar(r.qty),
        scalar(r.units, UNIT_PICK)));
      metricRowCount++;
    }

  let workoutCount = 0;
  const WO_UPSERT = `INSERT INTO workouts (id, name, day, start, end, duration_min, kcal, distance,
      distance_units, avg_hr, max_hr, source, raw)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, day = excluded.day, end = excluded.end,
      duration_min = excluded.duration_min, kcal = excluded.kcal, distance = excluded.distance,
      distance_units = excluded.distance_units, avg_hr = excluded.avg_hr, max_hr = excluded.max_hr,
      source = excluded.source, raw = excluded.raw`;
  for (const w of workouts) {
    const r = workoutRow(w);
    if (!r.day) continue;
    stmts.push(env.DB.prepare(WO_UPSERT).bind(
      scalar(r.id), scalar(r.name), scalar(r.day), scalar(r.start), scalar(r.end), scalar(r.duration_min), scalar(r.kcal),
      scalar(r.distance), scalar(r.distance_units), scalar(r.avg_hr), scalar(r.max_hr), scalar(r.source), scalar(r.raw),
    ));
    workoutCount++;
  }

  const CHUNK = 200; // D1 单批上限内分段执行
  for (let i = 0; i < stmts.length; i += CHUNK)
    await env.DB.batch(stmts.slice(i, i + CHUNK));

  // 曾在此检测「累计型指标每天只有 1 个点 → 建议关闭 Aggregate Data」并写入 warnings。
  // 该告警已移除：服务端 aggregateMetric() 对累计型按天求和，HAE 开启聚合后「每天 1 个点」
  // 正是推荐配置，检测必然误报。字段保留为空数组，以免破坏已有消费方的响应解析。
  const warnings = [];

  return json({ ok: true, metric_rows: metricRowCount, workouts: workoutCount, warnings, sleep_skipped: skippedSleep });
  } catch (e) {
    // 只写 Workers 日志（`wrangler tail` 可见）。不再把原始 payload 回写数据库——
    // 那会把完整健康数据原文落库，属于隐私风险。
    console.error('ingest failed:', e?.stack || e);
    return json({ error: 'ingest failed', detail: String(e?.stack || e).slice(0, 500) }, 500);
  }
}

/* ---------- 查询端 ---------- */

async function handleMetrics(env) {
  const { results } = await env.DB.prepare(
    `SELECT metric, units, slot, COUNT(*) AS n, MIN(date) AS first_day, MAX(date) AS last_day
     FROM metric_points GROUP BY metric, units, slot ORDER BY metric`,
  ).all();
  const byName = new Map();
  for (const r of results) {
    if (!byName.has(r.metric))
      byName.set(r.metric, { name: r.metric, units: r.units, slots: [], first_day: r.first_day, last_day: r.last_day, points: 0 });
    const m = byName.get(r.metric);
    m.slots.push(r.slot);
    m.points += r.n;
    if (r.first_day < m.first_day) m.first_day = r.first_day;
    if (r.last_day > m.last_day) m.last_day = r.last_day;
  }
  return json({ metrics: [...byName.values()] });
}

async function handleQuery(url, env) {
  const name = url.searchParams.get('name');
  if (!name) return json({ error: 'missing ?name=' }, 400);
  const from = url.searchParams.get('from') || '2000-01-01';
  const to = url.searchParams.get('to') || '2099-12-31';
  if (name === 'vo2_max_est') {
    // 派生指标的窗口语义是「从 to 往回数 N 天」，所以 to 的缺省值必须落在**今天**。
    // 沿用下面普通指标的 2099-12-31 会把 90 天窗口算到未来，HRmax 的查询区间落空，
    // 于是裸调用 /api/query?name=vo2_max_est 永远返回「参考最大心率不足，无法估算」。
    // （仪表盘与 pulse 都显式传了 to，所以之前没暴露 —— 但文档示例和手工调试一定踩。）
    // 只动 to，from 的缺省值保持 '2000-01-01'（不传 from 时仍返回全部可算的点）。
    const vto = url.searchParams.get('to') || shanghaiDay(new Date());
    return handleVo2MaxEst(url, env, from, vto);
  }
  const convert = url.searchParams.get('convert'); // kcal: kJ→kcal, km: m→km
  const { results } = await env.DB.prepare(
    `SELECT date, slot, qty, units FROM metric_points
     WHERE metric = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date`,
  ).bind(name, from, to).all();

  const factor = convert === 'kcal' ? 1 / KJ_PER_KCAL : convert === 'km' ? 1 / 1000 : 1;
  const byDay = new Map();
  let units = '';
  for (const r of results) {
    if (!units && r.units) units = r.units;
    if (!byDay.has(r.date)) byDay.set(r.date, { date: r.date });
    const v = r.qty * factor;
    byDay.get(r.date)[r.slot] = factor === 1 ? v : Math.round(v * 100) / 100;
  }
  const outUnits = convert === 'kcal' ? 'kcal' : convert === 'km' ? 'km' : units;
  return json({ name, units: outUnits, points: [...byDay.values()] });
}

async function handleWorkouts(url, env) {
  const from = url.searchParams.get('from') || '2000-01-01';
  const to = url.searchParams.get('to') || '2099-12-31';
  const { results } = await env.DB.prepare(
    `SELECT id, name, day, start, end, duration_min, kcal, distance, distance_units,
            avg_hr, max_hr, source
     FROM workouts WHERE day >= ?1 AND day <= ?2 ORDER BY start`,
  ).bind(from, to).all();
  return json({ workouts: results });
}

/* ---------- 入口 ---------- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'GET' && (path === '/' || path === '/healthz'))
      return json({ ok: true, service: 'hae-api', time: new Date().toISOString() });

    if (path === '/dashboard') {
      const sig = await dashSig(env);
      const setCookie = { 'Set-Cookie': `dash=${sig}; HttpOnly; Secure; Path=/; Max-Age=31536000; SameSite=Lax` };
      if (request.method === 'POST') { // 登录表单
        let pass = '';
        try { pass = (await request.formData()).get('pass') || ''; } catch {}
        if (env.DASH_TOKEN && pass === env.DASH_TOKEN)
          return new Response(null, { status: 302, headers: { Location: '/dashboard', ...setCookie } });
        return new Response(loginHTML('口令不对，再试一次'), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
      }
      const t = url.searchParams.get('t');
      const cookie = (request.headers.get('cookie') || '').match(/dash=([0-9a-f]{64})/);
      const ok = (env.DASH_TOKEN && t && t === env.DASH_TOKEN) || (cookie && cookie[1] === sig);
      if (!ok) return new Response(loginHTML(''), { status: 401, headers: { 'content-type': 'text/html; charset=utf-8' } });
      const headers = { 'content-type': 'text/html; charset=utf-8' };
      if (t && t === env.DASH_TOKEN) Object.assign(headers, setCookie); // 带 token 访问过一次就记住一年
      return new Response(dashboardHTML(env.READ_KEY), { headers });
    }

    if (request.method === 'POST' && path === '/api/data')
      return handleIngest(request, env);

    if (request.method === 'GET') {
      if (!env.READ_KEY || request.headers.get('api-key') !== env.READ_KEY)
        return json({ error: 'unauthorized' }, 401);
      if (path === '/api/metrics') return handleMetrics(env);
      if (path === '/api/query') return handleQuery(url, env);
      if (path === '/api/workouts') return handleWorkouts(url, env);
    }

    return json({ error: 'not found' }, 404);
  },
};
