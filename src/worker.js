/**
 * HAE API — Health Auto Export 的 Cloudflare 接收端
 *
 * 路由：
 *   POST /api/data                 iPhone HAE 推送（header: api-key = WRITE_KEY）
 *   GET  /                         健康检查（公开）
 *   GET  /api/metrics              指标清单           （header: api-key = READ_KEY）
 *   GET  /api/query?name=step_count&from=2026-01-01&to=2026-09-01
 *                                  指标时间序列       （header: api-key = READ_KEY）
 *   GET  /api/workouts?from=...&to=...  锻炼记录       （header: api-key = READ_KEY）
 *
 * 日期全部按 Asia/Shanghai 归到天，和 iPhone 上看到的一致。
 */

const TZ = 'Asia/Shanghai';
const KJ_TO_KCAL = 4.184;

/* ---------- 日期工具 ---------- */

function parseHaeDate(v) {
  if (!v) return null;
  // "2026-09-02 00:00:00 +0800" -> "2026-09-02T00:00:00+08:00"
  const s = String(v).trim().replace(' ', 'T').replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
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

/* ---------- 指标解析 ---------- */

// 累计型指标：一天的正确值 = 各分段之和（HAE 自带聚合会把它们错误地平均，所以必须在服务端求和）
const SUM_METRICS = new Set([
  'step_count', 'active_energy', 'basal_energy_burned',
  'walking_running_distance', 'cycling_distance', 'flights_climbed',
  'apple_exercise_time', 'apple_stand_time', 'apple_stand_hour',
  'time_in_daylight', 'dietary_water', 'mindful_minutes', 'handwashing',
]);

const SLEEP_SLOTS = [
  ['total', ['totalSleep', 'asleep']],
  ['deep', ['deep']],
  ['rem', ['rem']],
  ['core', ['core']],
  ['awake', ['awake']],
  ['inbed', ['inBed']],
];

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

/** 把一条 HAE metric 拆成数据行 { metric, date, slot, qty, units } */
export function metricRows(metric) {
  const name = metric?.name || 'unknown';
  const units = metric?.units || '';
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
        for (const [slot, keys] of SLEEP_SLOTS) {
          for (const k of keys) {
            const v = numOrNull(p[k]);
            if (v !== null) { rows.push({ metric: name, date, slot, qty: v, units: units || 'hr' }); break; }
          }
        }
      }
      continue;
    }

    const date = dayKey(p.date || p.startDate || p.sleepStart);
    if (!date) continue;

    if (name.includes('heart_rate')) {
      // 小时统计点带 Avg/Min/Max；日聚合后同样适用
      const a = numOrNull(p.Avg), mi = numOrNull(p.Min), ma = numOrNull(p.Max), q = numOrNull(p.qty);
      if (a !== null) rows.push({ metric: name, date, slot: 'avg', qty: a, units });
      if (mi !== null) rows.push({ metric: name, date, slot: 'min', qty: mi, units });
      if (ma !== null) rows.push({ metric: name, date, slot: 'max', qty: ma, units });
      if (a === null && mi === null && ma === null && q !== null)
        rows.push({ metric: name, date, slot: 'avg', qty: q, units });
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
  const name = metric?.name || 'unknown';
  const units = metric?.units || '';
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
        // 旧式汇总点：每键一行（后推覆盖，保留原语义）
        for (const [slot, keys] of SLEEP_SLOTS) {
          for (const k of keys) {
            const v = numOrNull(p[k]);
            if (v !== null) { day.slots.set(slot, { sum: v, count: 1, min: v, max: v }); break; }
          }
        }
      }
      continue;
    }

    const date = dayKey(p.date || p.startDate || p.sleepStart);
    if (!date) continue;
    let day = byDay.get(date);
    if (!day) { day = { slots: new Map() }; byDay.set(date, day); }

    if (name === 'heart_rate') {
      for (const [slot, key] of [['avg', 'Avg'], ['min', 'Min'], ['max', 'Max']]) {
        const v = numOrNull(p[key]);
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

  const energy = w?.activeEnergyBurned || w?.activeEnergy || w?.totalEnergy;
  let kcal = numOrNull(energy?.qty);
  if (kcal !== null && String(energy?.units || '').toLowerCase().startsWith('kj'))
    kcal = kcal / KJ_TO_KCAL;

  let avgHr = numOrNull(w?.avgHeartRate?.qty);
  let maxHr = numOrNull(w?.maxHeartRate?.qty);
  if (avgHr === null && w?.heartRate?.avg) avgHr = numOrNull(w.heartRate.avg.qty);
  if (maxHr === null && w?.heartRate.max) maxHr = numOrNull(w.heartRate.max.qty);
  if (avgHr !== null) avgHr = Math.round(avgHr * 10) / 10;
  if (maxHr !== null) maxHr = Math.round(maxHr * 10) / 10;

  return {
    id, name, day: dayKey(start), start, end,
    duration_min: dur === null ? null : dur / 60,
    kcal,
    distance: numOrNull(w?.distance?.qty),
    distance_units: scalar(w?.distance?.units, ['units', 'key', 'symbol']),
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

  const raw = await request.text(); // 先取原文，出错时留证据
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

  // 诊断：提取 sleep_analysis 结构样本（修完移除）
  try {
    const sleepM = metrics.find((m) => String(m?.name) === 'sleep_analysis');
    if (sleepM) {
      const pts = Array.isArray(sleepM.data) ? sleepM.data : [];
      // 紧凑样本：全量点关键字段 + value 标签分布（直方图）
      const labels = {};
      for (const p of pts) { const k = String(p?.value ?? p?.sleepStage ?? '?'); labels[k] = (labels[k] || 0) + 1; }
      const compact = pts.slice(0, 150).map((p) => ({ v: p?.value, q: p?.qty, s: p?.start || p?.startDate, e: p?.end || p?.endDate, src: p?.source }));
      const sample = JSON.stringify({ pt_count: pts.length, labels, compact });
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS debug_sleep_sample (ts TEXT, sample TEXT)').run();
      await env.DB.prepare('INSERT INTO debug_sleep_sample (ts, sample) VALUES (?1, ?2)')
        .bind(new Date().toISOString(), JSON.stringify(sample).slice(0, 100000)).run();
      await env.DB.prepare('DELETE FROM debug_sleep_sample WHERE ts NOT IN (SELECT ts FROM debug_sleep_sample ORDER BY ts DESC LIMIT 3)').run();
    }
  } catch (_) {}

  const stmts = [];
  let metricRowCount = 0;
  const preAggregated = data?.preaggregated === true; // Mac 端本地回填：已是"每天一行"，直接入库
  const toRows = preAggregated ? metricRows : aggregateMetric;
  const METRIC_UPSERT = `INSERT INTO metric_points (metric, date, slot, qty, units)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT(metric, date, slot) DO UPDATE SET qty = excluded.qty, units = excluded.units`;
  for (const m of metrics)
    for (const r of toRows(m)) {
      stmts.push(env.DB.prepare(METRIC_UPSERT).bind(scalar(r.metric), scalar(r.date), scalar(r.slot), scalar(r.qty), scalar(r.units, ['units', 'key', 'symbol'])));
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

  // 累计型指标若每天只来 1 个点，多半是 HAE「聚合」把日合计错误地平均了
  const warnings = [];
  if (!preAggregated)
    for (const m of metrics) {
      if (!SUM_METRICS.has(m?.name)) continue;
      const pts = Array.isArray(m.data) ? m.data : [];
      const dates = new Set(pts.map((p) => dayKey(p?.date || p?.startDate || p?.sleepStart)).filter(Boolean));
      if (pts.length >= 3 && dates.size >= 3 && pts.length === dates.size)
        warnings.push(`「${m.name}」每天只有 1 个点：请在自动化里关闭 Aggregate Data（开启时累计型指标会被错误平均）`);
    }

  return json({ ok: true, metric_rows: metricRowCount, workouts: workoutCount, warnings, sleep_skipped: skippedSleep });
  } catch (e) {
    // 诊断：异常时把错误 + 原始 payload 存入 debug_errors，500 响应体带回摘要
    console.error('ingest failed:', e?.stack || e);
    try {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS debug_errors (ts TEXT, err TEXT, body TEXT)').run();
      await env.DB.prepare('INSERT INTO debug_errors (ts, err, body) VALUES (?1, ?2, ?3)')
        .bind(new Date().toISOString(), String(e?.stack || e), raw.slice(0, 200000)).run();
    } catch (_) { /* 调试记录失败不掩盖原错误 */ }
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
  const convert = url.searchParams.get('convert'); // kcal: kJ→kcal, km: m→km
  const { results } = await env.DB.prepare(
    `SELECT date, slot, qty, units FROM metric_points
     WHERE metric = ?1 AND date >= ?2 AND date <= ?3 ORDER BY date`,
  ).bind(name, from, to).all();

  const factor = convert === 'kcal' ? 1 / 4.184 : convert === 'km' ? 1 / 1000 : 1;
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

/* ---------- 内置仪表盘页（/dashboard，Cookie 记住登录一年） ---------- */

async function dashSig(env) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(env.DASH_TOKEN || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode('dash-cookie-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loginHTML(msg) {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>健康 · 登录</title><style>
body{background:#0d1117;color:#e6edf3;font:15px/1.6 -apple-system,'PingFang SC',sans-serif;display:flex;align-items:center;justify-content:center;min-height:90vh;margin:0}
.box{background:#161b22;border:1px solid #21262d;border-radius:12px;padding:28px;width:min(320px,88vw);text-align:center}
h1{font-size:18px;margin:0 0 6px}p{color:#8b949e;font-size:12px;margin:0 0 18px}
input{width:100%;box-sizing:border-box;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:10px 12px;font-size:14px;margin-bottom:10px}
button{width:100%;background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:10px;font-size:14px;cursor:pointer}
.err{color:#f85149;font-size:12px;margin-top:10px}
</style></head><body><div class="box"><h1>🏃 健康 · HAE</h1><p>私有数据，请验证后访问</p>
<form method="post" action="/dashboard"><input type="password" name="pass" placeholder="访问口令" autofocus><button>进入</button></form>
${msg ? `<div class="err">${msg}</div>` : ''}</div></body></html>`;
}

function dashboardHTML(readKey) {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>健康 · HAE</title>
<script src="https://registry.npmmirror.com/echarts/5.5.1/files/dist/echarts.min.js"></script>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0d1117;color:#e6edf3;font:14px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 4px}
.sub{color:#8b949e;font-size:12px;margin-bottom:14px}
.range{display:inline-flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.range button{background:#161b22;color:#8b949e;border:1px solid #30363d;border-radius:16px;padding:4px 14px;cursor:pointer;font-size:13px}
.range button.on{color:#fff;border-color:#2f81f7;background:#1f3a5f}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.card{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:12px 14px}
.card .k{color:#8b949e;font-size:12px}
.card .v{font-size:24px;font-weight:600;margin-top:2px}
.card .d{color:#8b949e;font-size:11px;margin-top:2px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:12px}
.panel{background:#161b22;border:1px solid #21262d;border-radius:10px;padding:10px}
.panel h3{margin:2px 6px 0;font-size:13px;color:#c9d1d9;font-weight:500}
.chart{height:240px}
.wide{grid-column:1/-1}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:#8b949e;text-align:left;font-weight:500;padding:6px 8px;border-bottom:1px solid #21262d}
td{padding:6px 8px;border-bottom:1px solid #21262d}
.err{color:#f85149;font-size:12px;padding:8px}
</style></head><body>
<h1>🏃 健康 · HAE</h1>
<div class="sub">Apple Watch → Cloudflare · 数据每日自动更新</div>
<div class="range" id="range"></div>
<div class="cards" id="cards"></div>
<div class="grid" id="grid"></div>
<script>
var KEY='__READKEY__';var RANGE=90;var CH={};
function dstr(d){return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2)}
function from(){var d=new Date();d.setDate(d.getDate()-RANGE+1);return dstr(d)}
function to(){var d=new Date();d.setDate(d.getDate()+1);return dstr(d)}
function get(u){return fetch(u,{headers:{'api-key':KEY}}).then(function(r){return r.json()})}
function load(n,e){return get('/api/query?name='+n+(e||'')+'&from='+from()+'&to='+to()).then(function(j){return j.points||[]}).catch(function(){return []})}
function fmt(n,d){if(n==null||isNaN(n))return '--';return Number(n).toFixed(d==null?1:d)}
function last(pts,k){for(var i=pts.length-1;i>=0;i--){var v=k?pts[i][k]:pts[i].qty;if(v!=null&&v!==0)return{v:v,d:pts[i].date}}return{v:null,d:''}}
function chart(id){var el=document.getElementById(id);if(!el)return null;if(!CH[id]&&window.echarts)CH[id]=echarts.init(el);return CH[id]}
function draw(id,title,pts,series,opts){
 var box=document.getElementById(id);if(!box)return;
 if(!pts.length){box.innerHTML='<div class="err">暂无数据</div>';return}
 var c=chart(id);if(!c)return;
 var o={backgroundColor:'transparent',title:{text:title,left:6,top:4,textStyle:{fontSize:13,color:'#c9d1d9'}},
  tooltip:{trigger:'axis'},legend:{show:series.length>1,bottom:0,textStyle:{color:'#8b949e',fontSize:11}},
  grid:{left:44,right:14,top:34,bottom:series.length>1?38:24},
  xAxis:{type:'category',data:pts.map(function(p){return p.date.slice(5)}),axisLabel:{color:'#8b949e',fontSize:10}},
  yAxis:Object.assign({type:'value',axisLabel:{color:'#8b949e',fontSize:10},splitLine:{lineStyle:{color:'#21262d'}}},(opts&&opts.y)||{}),
  series:series.map(function(s){return Object.assign({type:s.type||'line',name:s.name,data:s.data,smooth:true,barMaxWidth:18,symbolSize:4,lineStyle:{width:2},itemStyle:{color:s.color}},s.extra||{})})};
 c.setOption(o,true);}
function addPanel(id,title,wide){var g=document.getElementById('grid');var d=document.createElement('div');d.className='panel'+(wide?' wide':'');d.innerHTML='<h3>'+title+'</h3><div class="chart" id="'+id+'"></div>';g.appendChild(d)}
function addCard(k,v,unit,d){var c=document.getElementById('cards');var e=document.createElement('div');e.className='card';e.innerHTML='<div class="k">'+k+'</div><div class="v">'+v+'<span style=font-size:12px;color:#8b949e> '+unit+'</span></div><div class="d">'+d+'</div>';c.appendChild(e)}
function render(){
 Object.keys(CH).forEach(function(k){try{CH[k].dispose()}catch(e){}});CH={};
 document.getElementById('cards').innerHTML='';document.getElementById('grid').innerHTML='';
 addPanel('c1','步数');addPanel('c2','活动热量 (kcal)');addPanel('c3','睡眠结构 (小时)');addPanel('c4','心率 min/avg/max');
 addPanel('c5','静息心率 (bpm)');addPanel('c6','HRV (ms)');addPanel('c7','体重 (kg)');addPanel('c8','血氧 (%)');
 addPanel('c9','步行+跑步距离 (km)');
 var P={};
 var jobs=[
  load('step_count').then(function(p){P.step=p;return load('active_energy','&convert=kcal')}).then(function(p){P.ae=p}),
  load('sleep_analysis').then(function(p){P.sleep=p.filter(function(x){return x.total>1})}),
  load('heart_rate').then(function(p){P.hr=p;return load('resting_heart_rate')}).then(function(p){P.rhr=p}),
  load('heart_rate_variability').then(function(p){P.hrv=p;return load('weight_body_mass')}).then(function(p){P.wt=p}),
  load('blood_oxygen_saturation').then(function(p){P.spo2=p;return load('walking_running_distance')}).then(function(p){P.dist=p}),
  load('apple_exercise_time').then(function(p){P.ex=p}),
  get('/api/workouts?from='+from()+'&to='+to()).then(function(j){P.wk=j.workouts||[]}).catch(function(){P.wk=[]})
 ];
 Promise.all(jobs).then(function(){
  var cs=[['步数',fmt(last(P.step).v,0),'步',last(P.step).d],
   ['活动热量',fmt(last(P.ae).v,0),'kcal',last(P.ae).d],
   ['睡眠',fmt(last(P.sleep).v!=null?last(P.sleep).v:last(P.sleep,'total'),1),'小时',last(P.sleep).d||last(P.sleep,'total').d],
   ['静息心率',fmt(last(P.rhr,'avg').v,0),'bpm',last(P.rhr,'avg').d],
   ['锻炼环',fmt(last(P.ex).v,0),'分钟',last(P.ex).d],
   ['体重',fmt(last(P.wt).v,1),'kg',last(P.wt).d]];
  cs.forEach(function(c){addCard(c[0],c[1],c[2],c[3])});
  draw('c1','步数',P.step,[{name:'步数',type:'bar',data:P.step.map(function(p){return p.qty}),color:'#58a6ff'}]);
  draw('c2','活动热量 (kcal)',P.ae,[{name:'kcal',data:P.ae.map(function(p){return p.qty}),color:'#f0883e'}]);
  draw('c3','睡眠结构 (小时)',P.sleep,[
   {name:'深睡',type:'bar',data:P.sleep.map(function(p){return p.deep}),color:'#8957e5',extra:{stack:'s'}},
   {name:'REM',type:'bar',data:P.sleep.map(function(p){return p.rem}),color:'#bc8cff',extra:{stack:'s'}},
   {name:'核心',type:'bar',data:P.sleep.map(function(p){return p.core}),color:'#58a6ff',extra:{stack:'s'}},
   {name:'清醒',type:'bar',data:P.sleep.map(function(p){return p.awake}),color:'#6e7681',extra:{stack:'s'}}]);
  draw('c4','心率 min/avg/max',P.hr,[
   {name:'min',data:P.hr.map(function(p){return p.min}),color:'#3fb950'},
   {name:'avg',data:P.hr.map(function(p){return p.avg}),color:'#e3b341'},
   {name:'max',data:P.hr.map(function(p){return p.max}),color:'#f85149'}]);
  draw('c5','静息心率 (bpm)',P.rhr,[{name:'bpm',data:P.rhr.map(function(p){return p.avg}),color:'#f85149'}]);
  draw('c6','HRV (ms)',P.hrv,[{name:'ms',data:P.hrv.map(function(p){return p.avg}),color:'#39d2c0'}]);
  draw('c7','体重 (kg)',P.wt,[{name:'kg',data:P.wt.map(function(p){return p.qty}),color:'#d29922',extra:{symbolSize:6}}]);
  draw('c8','血氧 (%)',P.spo2,[{name:'%',data:P.spo2.map(function(p){return p.qty}),color:'#58a6ff'}],{y:{min:85,max:100}});
  draw('c9','步行+跑步距离 (km)',P.dist,[{name:'km',type:'bar',data:P.dist.map(function(p){return p.qty}),color:'#7ee787'}]);
  renderWk(P.wk);
 });
}
function renderWk(wk){
 var g=document.getElementById('grid');var d=document.createElement('div');d.className='panel wide';
 if(!wk.length){d.innerHTML='<h3>锻炼记录</h3><div class="err">范围内暂无锻炼</div>';g.appendChild(d);return}
 var rows=wk.slice().reverse().slice(0,30).map(function(w){
  return '<tr><td>'+(w.day||'')+'</td><td>'+(w.name||'')+'</td><td>'+Math.round(w.duration_min||0)+' min</td><td>'+Math.round(w.kcal||0)+' kcal</td><td>'+(w.avg_hr?Math.round(w.avg_hr):'--')+' / '+(w.max_hr?Math.round(w.max_hr):'--')+' bpm</td></tr>'}).join('');
 d.innerHTML='<h3>锻炼记录（最近 '+Math.min(30,wk.length)+' 条）</h3><table><tr><th>日期</th><th>类型</th><th>时长</th><th>热量</th><th>心率 均/高</th></tr>'+rows+'</table>';
 g.appendChild(d);
}
function setRange(n){RANGE=n;var r=document.getElementById('range');r.innerHTML='';
 [7,30,90,365].forEach(function(x){var b=document.createElement('button');b.textContent=x+' 天';if(x===n)b.className='on';b.onclick=function(){setRange(x)};r.appendChild(b)});
 render()}
setRange(90);
window.addEventListener('resize',function(){Object.values(CH).forEach(function(c){c.resize()})});
</script></body></html>`
    .replace('__READKEY__', readKey);
}
