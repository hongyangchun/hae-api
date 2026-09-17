#!/usr/bin/env node
/**
 * 上报端（POST /api/data）边界用例回归测试。
 *
 * 为什么要有这个：HAE 在手机上推的数据形状会随版本、聚合设置、iOS 版本变化，
 * 而服务端的解析分支很多（累计型求和 / 标量平均 / 心率三槽 / 睡眠分段 vs 汇总 /
 * preaggregated）。这些分支出错时**接口照样返回 200、ok:true**，错误要到几天后
 * 看图表才发现。所以这里把每条分支的预期输出钉死。
 *
 * 全部离线：用 mock D1 接住所有写入的语句，不联网、不碰生产数据。
 * 用法: node scripts/verify_ingest.mjs
 */
import { handleIngest, metricRows } from '../src/worker.js';

/* ---------- mock D1：把 bind 过的参数原样接住 ---------- */
function makeDB() {
  const stmts = [];
  return {
    stmts,
    prepare(sql) {
      return { bind: (...args) => ({ sql, args }) };
    },
    async batch(chunk) {
      for (const s of chunk) stmts.push(s);
    },
  };
}

const WRITE_KEY = 'w-key';
const post = (payload, headers = {}) =>
  new Request('https://x/api/data', {
    method: 'POST',
    headers: { 'api-key': WRITE_KEY, 'content-type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });

async function ingest(payload, headers = {}) {
  const db = makeDB();
  const res = await handleIngest(post(payload, headers), { WRITE_KEY, DB: db });
  const body = await res.json().catch(() => null);
  return { status: res.status, body, stmts: db.stmts };
}

/* 取某个 metric 的写入行（metric_points 表） */
const rowsOf = (stmts, metric) =>
  stmts
    .filter((s) => s.sql.includes('INSERT INTO metric_points') && s.args[0] === metric)
    .map((s) => ({ date: s.args[1], slot: s.args[2], qty: s.args[3], units: s.args[4] }));
const woRows = (stmts) => stmts.filter((s) => s.sql.includes('INSERT INTO workouts')).map((s) => ({
  id: s.args[0], name: s.args[1], day: s.args[2], duration_min: s.args[5], kcal: s.args[6],
  distance: s.args[7], avg_hr: s.args[9], max_hr: s.args[10],
}));

let pass = 0, fail = 0;
const chk = (ok, msg, extra = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? '✅' : '❌'} ${msg}${extra ? '  → ' + extra : ''}`);
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const near = (a, b, tol = 1e-6) => typeof a === 'number' && Math.abs(a - b) < tol;

/* 一天多分段、带时区（真实的 HAE 形状） */
const pt = (d, t, q) => ({ date: `${d} ${t}:00 +0800`, qty: q });

console.log('========== A. 鉴权与入口 ==========');
{
  const noKey = await handleIngest(
    new Request('https://x/api/data', { method: 'POST', body: '{}' }), { WRITE_KEY, DB: makeDB() });
  chk(noKey.status === 401, '缺 api-key → 401', `实际 ${noKey.status}`);

  const badKey = await handleIngest(
    new Request('https://x/api/data', { method: 'POST', headers: { 'api-key': 'wrong' }, body: '{}' }),
    { WRITE_KEY, DB: makeDB() });
  chk(badKey.status === 401, '错误 api-key → 401', `实际 ${badKey.status}`);

  const noServerKey = await handleIngest(
    new Request('https://x/api/data', { method: 'POST', headers: { 'api-key': 'w-key' }, body: '{}' }),
    { DB: makeDB() });
  chk(noServerKey.status === 401, '服务端未配置 WRITE_KEY 时拒绝一切 → 401（不能放行）', `实际 ${noServerKey.status}`);
}

console.log('\n========== B. 非法输入 ==========');
{
  const r = await ingest('{not json');
  chk(r.status === 400, '非法 JSON → 400 而不是 500', `实际 ${r.status} ${JSON.stringify(r.body)}`);

  const r2 = await ingest({});
  chk(r2.status === 200 && r2.body?.ok === true, '空对象 → 200 ok（宽容）', JSON.stringify(r2.body));
  chk(r2.body?.metric_rows === 0 && r2.body?.workouts === 0, '空对象不写入任何行');

  const r3 = await ingest({ data: { metrics: 'not-an-array', workouts: 42 } });
  chk(r3.status === 200 && r3.body?.metric_rows === 0,
    'metrics/workouts 不是数组时不崩、不写行', JSON.stringify(r3.body));

  const r4 = await ingest({ data: { metrics: [null, 'x', { name: 'step_count', data: null }, { name: 'step_count', data: [null, 1, 'a'] }] } });
  chk(r4.status === 200, 'metric 里混入 null/字符串/非数组 data → 全跳过、不崩', JSON.stringify(r4.body));
}

console.log('\n========== C. 累计型指标必须求和（HAE 会给小时分段）==========');
{
  const r = await ingest({ data: { metrics: [{
    name: 'step_count', units: 'count',
    data: [pt('2026-09-10', '09:00', 1000), pt('2026-09-10', '10:00', 1500), pt('2026-09-10', '11:00', 800)],
  }] } });
  const rows = rowsOf(r.stmts, 'step_count');
  chk(rows.length === 1, '一天 3 个分段 → 收起 1 行', `${rows.length} 行`);
  chk(near(rows[0]?.qty, 3300), '值 = 1000+1500+800 = 3300（求和而非平均）', `实际 ${rows[0]?.qty}`);
  chk(rows[0]?.slot === 'qty', '槽位是 qty');

  // 同一指标跨两天 → 两天各一行
  const r2 = await ingest({ data: { metrics: [{
    name: 'flights_climbed', units: 'count',
    data: [pt('2026-09-10', '09:00', 3), pt('2026-09-11', '09:00', 5), pt('2026-09-11', '18:00', 2)],
  }] } });
  const rows2 = rowsOf(r2.stmts, 'flights_climbed');
  chk(rows2.length === 2, '跨两天 → 2 行', `${rows2.length} 行`);
  chk(near(rows2.find((x) => x.date === '2026-09-11')?.qty, 7), '第二天 5+2=7', `${rows2.find((x) => x.date === '2026-09-11')?.qty}`);

  // 累计型清单完整性：改了 SUM_METRICS 而漏掉某个指标会静默变成「平均」
  for (const n of ['active_energy', 'basal_energy_burned', 'apple_exercise_time', 'apple_stand_time',
    'walking_running_distance', 'time_in_daylight', 'dietary_water', 'handwashing', 'apple_stand_hour']) {
    const rr = await ingest({ data: { metrics: [{ name: n, units: 'u',
      data: [pt('2026-09-10', '09:00', 10), pt('2026-09-10', '10:00', 20)] }] } });
    const q = rowsOf(rr.stmts, n)[0]?.qty;
    chk(near(q, 30), `${n} 也走求和（10+20=30）`, `实际 ${q}`);
  }
}

console.log('\n========== D. 标量型指标必须取平均（不能求和）==========');
{
  const cases = [['walking_speed', 3.0, 4.0, 3.5], ['heart_rate_variability', 30, 40, 35],
    ['resting_heart_rate', 50, 60, 55], ['physical_effort', 1, 3, 2], ['walking_step_length', 60, 64, 62]];
  for (const [n, a, b, want] of cases) {
    const r = await ingest({ data: { metrics: [{ name: n, units: 'u',
      data: [pt('2026-09-10', '09:00', a), pt('2026-09-10', '10:00', b)] }] } });
    const q = rowsOf(r.stmts, n)[0]?.qty;
    chk(near(q, want), `${n} 两点取平均 = ${want}（而非求和 ${a + b}）`, `实际 ${q}`);
  }
}

console.log('\n========== E. heart_rate 三槽 ==========');
{
  const r = await ingest({ data: { metrics: [{
    name: 'heart_rate', units: 'count/min',
    data: [{ date: '2026-09-10 09:00:00 +0800', Avg: 80, Min: 60, Max: 100 },
           { date: '2026-09-10 10:00:00 +0800', Avg: 90, Min: 70, Max: 120 }],
  }] } });
  const rows = rowsOf(r.stmts, 'heart_rate');
  chk(rows.length === 3, '一天 → 恰好 avg/min/max 三行', `${rows.length} 行`);
  chk(near(rows.find((x) => x.slot === 'avg')?.qty, 85), 'avg = 两点均值 85');
  chk(near(rows.find((x) => x.slot === 'min')?.qty, 60), 'min = 最小 60（不是平均）');
  chk(near(rows.find((x) => x.slot === 'max')?.qty, 120), 'max = 最大 120（不是平均）');

  // 只有 qty 的心率点也要落到 avg，不能整段丢
  const r2 = await ingest({ data: { metrics: [{ name: 'heart_rate', units: 'count/min',
    data: [pt('2026-09-10', '09:00', 70), pt('2026-09-10', '10:00', 90)] }] } });
  const rows2 = rowsOf(r2.stmts, 'heart_rate');
  chk(rows2.length === 1 && rows2[0].slot === 'avg' && near(rows2[0].qty, 80),
    '只有 qty 的心率点也要落到 avg（两点取均 80）—— HAE 一旦只发 qty，不能整段消失',
    JSON.stringify(rows2));

  // 其余含 heart_rate 字样的指标一律 qty（历史上写成两个槽导致仪表盘只有 6 天数据）
  for (const n of ['resting_heart_rate', 'heart_rate_variability', 'walking_heart_rate_average']) {
    const rr = await ingest({ data: { metrics: [{ name: n, units: 'u', data: [pt('2026-09-10', '09:00', 55)] }] } });
    const slots = rowsOf(rr.stmts, n).map((x) => x.slot);
    chk(eq(slots, ['qty']), `${n} 写 qty 槽而不是 avg/min/max`, JSON.stringify(slots));
  }
}

console.log('\n========== F. 睡眠：分段式应拒绝，汇总式应保留 ==========');
{
  // 分段式（v10 REST 未开聚合的碎片），不该收
  const seg = await ingest({ data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { start: '2026-09-10 23:00:00 +0800', end: '2026-09-10 23:30:00 +0800', value: '核心' },
    { start: '2026-09-10 23:30:00 +0800', end: '2026-09-11 00:10:00 +0800', value: '深度' },
  ] }] } });
  chk(rowsOf(seg.stmts, 'sleep_analysis').length === 0, '分段式睡眠被丢弃（不全，会污染图表）');
  chk(seg.body?.sleep_skipped === 1, 'sleep_skipped 计数为 1', `${seg.body?.sleep_skipped}`);

  // 同样内容带 X-HAE-Source: icloud-json（回填）→ 应全收
  const seg2 = await ingest({ data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { start: '2026-09-10 23:00:00 +0800', end: '2026-09-10 23:30:00 +0800', value: '核心' },
    { start: '2026-09-11 00:00:00 +0800', end: '2026-09-11 00:30:00 +0800', value: '深度' },
  ] }] } }, { 'x-hae-source': 'icloud-json' });
  const segRows = rowsOf(seg2.stmts, 'sleep_analysis');
  chk(segRows.length === 2, '回填标记下分段式全收 → 2 行', `${segRows.length}`);

  // 汇总式
  const sum = await ingest({ data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { date: '2026-09-11 07:00:00 +0800', totalSleep: 6.5, deep: 0.8, rem: 1.2, core: 4.5, awake: 0.3 },
  ] }] } });
  const sRows = rowsOf(sum.stmts, 'sleep_analysis');
  const slotOf = (k) => sRows.find((x) => x.slot === k)?.qty;
  chk(slotOf('total') === 6.5 && slotOf('deep') === 0.8 && slotOf('rem') === 1.2 && slotOf('core') === 4.5 && slotOf('awake') === 0.3,
    '汇总式五个槽都写入', JSON.stringify(sRows));
  chk(near(slotOf('unclassified'), 0), 'unclassified = 6.5-(0.8+1.2+4.5) = 0（必须单独成槽）', `${slotOf('unclassified')}`);

  // total 缺失时用分类求和兜底
  const sum2 = await ingest({ data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { date: '2026-09-11 07:00:00 +0800', deep: 1, rem: 1, core: 4 },
  ] }] } });
  chk(near(rowsOf(sum2.stmts, 'sleep_analysis').find((x) => x.slot === 'total')?.qty, 6),
    '缺 totalSleep 时用 deep+rem+core 兜底 = 6', JSON.stringify(rowsOf(sum2.stmts, 'sleep_analysis')));

  // inBed 补算
  const sum3 = await ingest({ data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { date: '2026-09-11 07:00:00 +0800', totalSleep: 6, inBed: 0,
      inBedStart: '2026-09-10 23:00:00 +0800', inBedEnd: '2026-09-11 07:30:00 +0800' },
  ] }] } });
  const ib = rowsOf(sum3.stmts, 'sleep_analysis').find((x) => x.slot === 'inbed')?.qty;
  chk(near(ib, 8.5), 'inBed=0 时用 inBedEnd-inBedStart 补算 = 8.5h', `${ib}`);

  // inbed 补算失败必须干脆不写这个槽，而不是写 0
  const sum4 = await ingest({ data: { metrics: [{ name: 'sleep_analysis', units: 'hr', data: [
    { date: '2026-09-11 07:00:00 +0800', totalSleep: 6, inBed: 0 },
  ] }] } });
  const ib2 = rowsOf(sum4.stmts, 'sleep_analysis').find((x) => x.slot === 'inbed');
  chk(ib2 === undefined,
    'inBed=0 又无从补算时 → 不写这个槽（0 小时在床不可能；线上曾因此有 16/19 天是 0）',
    JSON.stringify(ib2));
}

console.log('\n========== G. preaggregated 不再被信任（必须与正常路径同值）==========');
{
  // 一天一行、值就是日聚合值 —— 这是 preaggregated 的正确用法
  const ok = await ingest({ data: { preaggregated: true, metrics: [{ name: 'step_count', units: 'count',
    data: [{ qty: 8000, date: '2026-09-10 00:00:00 +0800' }] }] } });
  chk(near(rowsOf(ok.stmts, 'step_count')[0]?.qty, 8000), '正确用法（一天一行）→ 8000', `${rowsOf(ok.stmts, 'step_count')[0]?.qty}`);

  // 误标：分段数据 + preaggregated:true → 必须仍按分段聚合、只写 1 行
  const pts = [pt('2026-09-10', '02:00', 1), pt('2026-09-10', '10:00', 3), pt('2026-09-10', '20:00', 2)];
  const misuse = await ingest({ data: { preaggregated: true, metrics: [{ name: 'physical_effort', units: 'kcal/hr·kg', data: pts }] } });
  const normal = await ingest({ data: { metrics: [{ name: 'physical_effort', units: 'kcal/hr·kg', data: pts }] } });
  const a = rowsOf(misuse.stmts, 'physical_effort');
  const b = rowsOf(normal.stmts, 'physical_effort');
  chk(a.length === 1 && b.length === 1, '两条路径都只写 1 行（不再逐条入库互相覆盖）',
    `误标 ${a.length} 行 / 正常 ${b.length} 行`);
  chk(eq(a, b), '误标 preaggregated 与正常路径结果完全一致', JSON.stringify(a));

  // 用「尾值 ≠ 均值」的数据再验一次，避免靠巧合通过
  const pts2 = [pt('2026-09-10', '02:00', 1), pt('2026-09-10', '10:00', 4), pt('2026-09-10', '20:00', 1)];
  const m2 = await ingest({ data: { preaggregated: true, metrics: [{ name: 'physical_effort', units: 'kcal/hr·kg', data: pts2 }] } });
  const r2 = rowsOf(m2.stmts, 'physical_effort');
  chk(r2.length === 1 && near(r2[0]?.qty, 2),
    '尾值 1 时仍取到均值 2 —— 旧实现会写成 1（-50%，实测线上有 -60.5% 的案例）', JSON.stringify(r2));
  chk(!r2.some((x) => typeof x.qty === 'number' && String(x.qty).split('.')[1]?.length > 3),
    '写入值已取整（不再出现 3.766666571299235 这类超长小数）');

  // 睡眠的汇总式点走 preaggregated 也不能变
  const sl = await ingest({ data: { preaggregated: true, metrics: [{ name: 'sleep_analysis', units: 'hr',
    data: [{ date: '2026-09-11 07:00:00 +0800', totalSleep: 7, deep: 1, rem: 1, core: 5 }] }] } });
  const sRows = rowsOf(sl.stmts, 'sleep_analysis');
  chk(sRows.length === 5 && sRows.find((x) => x.slot === 'total')?.qty === 7,
    'preaggregated 下睡眠汇总式点仍正确展开成 5 槽', JSON.stringify(sRows.map((x) => x.slot)));
}

console.log('\n========== H. 异常数据点不应污染 ==========');
{
  const r = await ingest({ data: { metrics: [{ name: 'step_count', units: 'count', data: [
    { qty: 100, date: '2026-09-10 09:00:00 +0800' },
    { qty: 200 },                                  // 无日期
    { qty: 'abc', date: '2026-09-10 10:00:00 +0800' },   // 非数值
    { qty: null, date: '2026-09-10 11:00:00 +0800' },    // null
    { qty: NaN, date: '2026-09-10 12:00:00 +0800' },     // NaN
    { qty: 300, date: 'invalid-date' },            // 非法日期
  ] }] } });
  const rows = rowsOf(r.stmts, 'step_count');
  chk(rows.length === 1 && near(rows[0].qty, 100), '只收下有效那 1 个点（其余全跳过）', JSON.stringify(rows));

  // 字段是对象（新版 HAE 偶发）→ 必须在源头解析成字符串，不能 JSON 兜底成片段
  const r2 = await ingest({ data: { metrics: [{ name: { value: 'step_count' }, units: { value: 'count' },
    data: [{ qty: 500, date: '2026-09-10 09:00:00 +0800' }] }] } });
  const objRows = rowsOf(r2.stmts, 'step_count');
  chk(objRows.length === 1 && near(objRows[0].qty, 500),
    'metric.name 是对象时能取出脚本值（scalar 兜底）', JSON.stringify(objRows));
  chk(typeof objRows[0]?.units === 'string' && !objRows[0].units.includes('{'),
    'units 是对象时也被解析成干净字符串（曾写成 {"value":"count"}）',
    JSON.stringify(objRows[0]?.units));

  // 负值（HAE 不该给，但要能观察到）
  const r3 = await ingest({ data: { metrics: [{ name: 'active_energy', units: 'kJ',
    data: [pt('2026-09-10', '09:00', -5)] }] } });
  chk(near(rowsOf(r3.stmts, 'active_energy')[0]?.qty, -5),
    '负值被原样写入（目前无校验）—— 若源端出错会静默入库');
}

console.log('\n========== I. 锻炼记录 ==========');
{
  const r = await ingest({ data: { workouts: [{
    id: 'W1', name: '高强度间歇训练',
    start: '2026-09-10 19:00:00 +0800', end: '2026-09-10 20:00:00 +0800',
    duration: 3600, activeEnergyBurned: { qty: 418.4, units: 'kcal' },
    avgHeartRate: { qty: 130.44 }, maxHeartRate: { qty: 175.96 },
  }, {
    // 没有 duration，要靠起止时间补算
    id: 'W2', name: '骑行',
    start: '2026-09-10 07:00:00 +0800', end: '2026-09-10 07:45:00 +0800',
    activeEnergyBurned: { qty: 1000, units: 'kJ' },
  }] } });
  const [w1, w2] = woRows(r.stmts);
  chk(w1?.day === '2026-09-10', 'day 按 Asia/Shanghai 归到 09-10', `${w1?.day}`);
  chk(near(w1?.duration_min, 60), 'duration 3600s → 60 分钟', `${w1?.duration_min}`);
  chk(near(w1?.avg_hr, 130.4) && near(w1?.max_hr, 176), 'avg/max 心率保留 1 位小数（130.4 / 176）', `${w1?.avg_hr} / ${w1?.max_hr}`);
  chk(near(w2?.duration_min, 45), '缺 duration 时用起止时间补算 = 45 分钟', `${w2?.duration_min}`);
  chk(near(w2?.kcal, Math.round(1000 / 4.184 * 10) / 10), 'kJ 单位的能量换算成 kcal（238.6）', `${w2?.kcal}`);

  // 真实 HAE 的 duration 是浮点秒（3915.673400044441），必须收敛 ——
  // 线上曾把 71.96487963199615 分钟 / 361.36192551290105 kcal 直接写进 DB。
  const rf = await ingest({ data: { workouts: [{ id: 'W9', name: '传统力量训练',
    start: '2026-09-11 17:33:44 +0800', end: '2026-09-11 18:39:00 +0800',
    duration: 3915.673400044441,
    activeEnergyBurned: { qty: 1237.99968412111, units: 'kJ' } }] } });
  const rw = woRows(rf.stmts)[0];
  chk(/^\d+(\.\d)?$/.test(String(rw?.duration_min)), '浮点秒 → ≤1 位小数的分钟', `${rw?.duration_min}`);
  chk(/^\d+(\.\d)?$/.test(String(rw?.kcal)), '浮点能量 → ≤1 位小数的 kcal', `${rw?.kcal}`);

  // 能耗兜底：activeEnergy 是**数组**，不能让它短路掉 totalEnergy
  const en = await ingest({ data: { workouts: [{ id: 'W4', name: '骑行',
    start: '2026-09-10 19:00:00 +0800', end: '2026-09-10 20:00:00 +0800',
    totalEnergy: { qty: 1669.9002428056203, units: 'kJ' },
    activeEnergy: [{ qty: 17.2, units: 'kJ' }, { qty: 18.5, units: 'kJ' }] }] } });
  const we = woRows(en.stmts)[0];
  chk(near(we?.kcal, Math.round(1669.9002428056203 / 4.184 * 10) / 10),
    '缺 activeEnergyBurned 时落到 totalEnergy（旧实现被 activeEnergy 数组短路成 null）', `${we?.kcal}`);

  const en2 = await ingest({ data: { workouts: [{ id: 'W6', name: '骑行',
    start: '2026-09-10 19:00:00 +0800', end: '2026-09-10 20:00:00 +0800',
    activeEnergy: [{ qty: 100, units: 'kcal' }, { qty: 200, units: 'kcal' }] }] } });
  chk(near(woRows(en2.stmts)[0]?.kcal, 300), '只剩逐分钟数组时可求和（100+200=300）', `${woRows(en2.stmts)[0]?.kcal}`);

  // 无心率字段的锻炼（App 里手动记录 / 没戴表的那次）不能拖垮整单
  const nohr = await ingest({ data: {
    metrics: [{ name: 'step_count', units: 'count', data: [pt('2026-09-10', '09:00', 100)] }],
    workouts: [{ id: 'W5', name: '手动记录的训练',
      start: '2026-09-10 19:00:00 +0800', end: '2026-09-10 20:00:00 +0800' }] } });
  chk(nohr.status === 200, '既无 heartRate 又无 maxHeartRate 的锻炼 → 请求仍 200（不再整单 500）', `${nohr.status}`);
  chk(near(rowsOf(nohr.stmts, 'step_count')[0]?.qty, 100),
    '同请求里的指标照常入库 —— 真正的损失是「一条坏锻炼拖垮当天全部数据」',
    JSON.stringify(rowsOf(nohr.stmts, 'step_count')));
  chk(woRows(nohr.stmts)[0]?.avg_hr === null && woRows(nohr.stmts)[0]?.max_hr === null,
    '该锻炼的心率字段写 null 而不是抛异常');

  // 缺 day 的锻炼应被跳过
  const r2 = await ingest({ data: { workouts: [{ id: 'W3', name: 'x' }] } });
  chk(woRows(r2.stmts).length === 0, '完全没有时间的锻炼 → 跳过（不写脏行）');
  chk(r2.body?.workouts === 0, 'workouts 计数不把它算进去');

  const r3 = await ingest({ data: { workouts: [
    { name: 'A', start: '2026-09-10 08:00:00 +0800' },
    { name: 'A', start: '2026-09-10 08:00:00 +0800' },
  ] } });
  const ids = woRows(r3.stmts).map((x) => x.id);
  chk(new Set(ids).size === 1,
    '同名同开始时间 → 兜底 id 相同、UPSERT 合成一条（设计后果；HAE 带 UUID 时不触发）',
    JSON.stringify(ids));
}

console.log('\n========== J. 幂等：重复推送同一天 ==========');
{
  const payload = { data: { metrics: [{ name: 'step_count', units: 'count',
    data: [pt('2026-09-10', '09:00', 1000), pt('2026-09-10', '10:00', 2000)] }] } };
  const r1 = await ingest(payload);
  const r2 = await ingest(payload);
  const a = rowsOf(r1.stmts, 'step_count')[0];
  const b = rowsOf(r2.stmts, 'step_count')[0];
  chk(eq([a?.date, a?.slot, a?.qty], [b?.date, b?.slot, b?.qty]),
    '同样 payload 推两次 → 写入完全一致的值（靠 UPSERT 去重，不是累加）', JSON.stringify(b));
  chk(near(a?.qty, 3000), '值仍是 3000，不会变成 6000（没有重复累加）', `${a?.qty}`);
}

console.log('\n========== K. 大批量分片 ==========');
{
  // 1500 个点 → 语句数远超 CHUNK=200，验证分片不丢
  const data = [];
  for (let i = 0; i < 1500; i++) data.push(pt('2026-09-10', '09:00', 1));
  const r = await ingest({ data: { metrics: [{ name: 'step_count', units: 'count', data }] } });
  chk(r.body?.metric_rows === 1, '1500 个同点收敛成 1 行', `${r.body?.metric_rows}`);
  chk(r.stmts.length === 1, '写入语句也是 1 条');

  const data2 = [];
  for (let d = 1; d <= 25; d++) data2.push(pt(`2026-09-${String(d).padStart(2, '0')}`, '09:00', d));
  const r2 = await ingest({ data: { metrics: [{ name: 'step_count', units: 'count', data: data2 }] } });
  chk(r2.stmts.length === 25, '25 天 → 25 条语句（跨 200 的分片边界）', `${r2.stmts.length}`);
}

console.log('\n========== L. metric_rows 计数与实际写入一致 ==========');
{
  const r = await ingest({ data: { metrics: [
    { name: 'step_count', units: 'count', data: [pt('2026-09-10', '09:00', 100)] },
    { name: 'heart_rate', units: 'count/min', data: [{ date: '2026-09-10 09:00:00 +0800', Avg: 80, Min: 60, Max: 100 }] },
    { name: 'sleep_analysis', units: 'hr', data: [{ date: '2026-09-11 07:00:00 +0800', totalSleep: 7, deep: 1, rem: 1, core: 5 }] },
  ], workouts: [] } });
  const written = r.stmts.filter((s) => s.sql.includes('INSERT INTO metric_points')).length;
  chk(r.body?.metric_rows === written,
    '响应里的 metric_rows 等于实际发出的写入语句数（否则报数不可信）',
    `响应 ${r.body?.metric_rows} vs 实际 ${written}`);
}

console.log(`\n${'='.repeat(52)}`);
if (fail === 0) console.log(`全部通过 ✅  (${pass} 项)`);
else console.log(`${fail} 项失败 ❌ / 共 ${pass + fail} 项`);
process.exit(fail ? 1 : 0);
