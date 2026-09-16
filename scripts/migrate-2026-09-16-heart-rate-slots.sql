-- 2026-09-16 · 修复单值心率类指标的双槽问题
--
-- 症状：仪表盘上的静息心率只画到 6 天、HRV 只画到 7 天（数据其实有 18~19 天）。
--
-- 根因：worker.js 里两条入库路径对「哪些指标用 avg/min/max 槽」判断不一致 ——
--   metricRows()     用 name.includes('heart_rate')  → resting_heart_rate 等被写成 avg
--   aggregateMetric() 用 name === 'heart_rate'       → 同一个指标被写成 qty
-- 于是同一天同时存在 avg 槽（08-29~09-03，来自 Mac 回填）与 qty 槽（08-30 起，来自 iPhone 推送），
-- 仪表盘读 avg（只有 6 天），pulse 插件读 qty（19 天）。
--
-- 处理：统一为 qty。qty 已存在的日期保留原值（该值来自 iPhone 日聚合推送，也是插件一直在用的值）。
-- 只有 2026-08-29 这天仅有 avg，会被搬成 qty 从而保住。
--
-- 幂等：可重复执行。

INSERT OR IGNORE INTO metric_points (metric, date, slot, qty, units)
SELECT metric, date, 'qty', qty, units
  FROM metric_points
 WHERE metric IN ('resting_heart_rate', 'heart_rate_variability', 'walking_heart_rate_average')
   AND slot = 'avg';

DELETE FROM metric_points
 WHERE metric IN ('resting_heart_rate', 'heart_rate_variability', 'walking_heart_rate_average')
   AND slot = 'avg';

-- 核对：以下三条应各只有 qty 一种 slot
--   SELECT metric, GROUP_CONCAT(DISTINCT slot) FROM metric_points
--    WHERE metric IN ('resting_heart_rate','heart_rate_variability','walking_heart_rate_average')
--    GROUP BY metric;
