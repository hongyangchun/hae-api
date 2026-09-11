#!/usr/bin/env node
/**
 * 本地验证：用真实 HAE 导出 JSON 跑服务端聚合逻辑（mock D1，不联网）。
 * 已知基准（来自 iCloud 09-01 文件手工核算）：
 *   active_energy 09-01 sum = 2970.9 kJ ≈ 710 kcal
 *   walking_running_distance 09-01 sum = 4.1 km
 * 用法: node scripts/test_ingest.mjs [指标JSON路径] [锻炼JSON路径]
 */
import { readFileSync } from 'node:fs';
import { aggregateMetric, workoutRow } from '../src/worker.js';

const DEFAULT_ROOT = process.env.HOME +
  '/Library/Mobile Documents/iCloud~com~ifunography~HealthExport/Documents';
const metricsPath = process.argv[2] || `${DEFAULT_ROOT}/健康 iCloud/HealthAutoExport-2026-09-01.json`;
const workoutsPath = process.argv[3] || `${DEFAULT_ROOT}/锻炼 iCloud/HealthAutoExport-2026-08-31.json`;

const load = (p) => JSON.parse(readFileSync(p, 'utf8'));

const mPayload = load(metricsPath);
const metrics = mPayload?.data?.metrics ?? [];
const allRows = metrics.flatMap((m) => aggregateMetric(m));
console.log(`[aggregate] 指标数: ${metrics.length}, 聚合后行数: ${allRows.length}`);
console.log(`[aggregate] 非法日期行: ${allRows.filter((r) => !/^\d{4}-\d{2}-\d{2}$/.test(r.date)).length}`);

// 基准核对
const rowOf = (name, date, slot = 'qty') =>
  allRows.find((r) => r.metric === name && r.date === date && r.slot === slot)?.qty;

const ae = rowOf('active_energy', '2026-09-01');
const wrd = rowOf('wrd', 'x') ?? rowOf('walking_running_distance', '2026-09-01');
console.log(`\n[基准] active_energy 09-01 = ${ae} kJ (期望 ~2970.9, 即 710 kcal) ${ae && Math.abs(ae - 2970.9) < 1 ? '✓' : '✗'}`);
console.log(`[基准] walking_running_distance 09-01 = ${wrd} km (期望 ~4.1) ${wrd && Math.abs(wrd - 4.1) < 0.05 ? '✓' : '✗'}`);

const hrAvg = rowOf('heart_rate', '2026-09-01', 'avg');
const hrMin = rowOf('heart_rate', '2026-09-01', 'min');
const hrMax = rowOf('heart_rate', '2026-09-01', 'max');
console.log(`[基准] heart_rate 09-01 avg/min/max = ${hrAvg}/${hrMin}/${hrMax} (期望 avg 介于 min-max) ${hrMin <= hrAvg && hrAvg <= hrMax ? '✓' : '✗'}`);

const sleep = allRows.filter((r) => r.metric === 'sleep_analysis' && r.date === '2026-09-01');
console.log(`[基准] sleep_analysis 09-01 slots = ${sleep.map((s) => `${s.slot}:${s.qty.toFixed(2)}`).join(' ')}${sleep.length ? ' ✓' : ' ✗'}`);

// 其余指标抽样
const byName = new Map();
for (const r of allRows) byName.set(r.metric, (byName.get(r.metric) || 0) + 1);
console.log(`\n[抽样] 每指标行数:`, [...byName].slice(0, 12).map(([n, c]) => `${n}=${c}`).join(', '));

// 锻炼
try {
  const workouts = load(workoutsPath)?.data?.workouts ?? [];
  console.log(`\n[workouts] 条数: ${workouts.length}`);
  for (const w of workouts.slice(0, 3)) {
    const r = workoutRow(w);
    console.log(`  - [${r.day}] ${r.name} ${Math.round(r.duration_min)}min kcal=${r.kcal?.toFixed?.(1)} hr=${r.avg_hr}-${r.max_hr}`);
  }
} catch (e) { console.log(`[workouts] 跳过: ${e.message}`); }

// 全链路 mock（含 preaggregated 分支）
const { default: worker } = await import('../src/worker.js');
const req = new Request('https://x/api/data', {
  method: 'POST', headers: { 'api-key': 'k' },
  body: JSON.stringify({ data: { metrics, workouts: load(workoutsPath)?.data?.workouts ?? [] } }),
});
const res = await worker.fetch(req, { WRITE_KEY: 'k', READ_KEY: 'r', DB: { prepare: () => ({ bind: () => ([]) }), batch: async () => {} } });
console.log(`\n[ingest] mock 状态 ${res.status}: ${(await res.text()).slice(0, 120)}`);
console.log('DONE');
