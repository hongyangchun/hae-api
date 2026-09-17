-- 收敛「超精度小数」到与正常入库路径一致的精度
--
-- 背景：handleIngest 曾经在客户端自报 `preaggregated: true` 时走 metricRows（原样逐条
-- 入库）。那条路径**不做任何取整**，于是把 HAE 的原始浮点直接写进了库。残留指纹是
-- 小数位 > 3 的值 —— 全部集中在 2026-08-28 / 2026-08-29 两天（那两天是 Mac 端回填导入的）：
--
--   apple_sleeping_wrist_temperature  2026-08-28  35.63467025756836
--   environmental_audio_exposure      2026-08-29  51.86750174956889
--   headphone_audio_exposure          2026-08-29  48.38522690146726
--   heart_rate_variability            2026-08-29  32.29529323773504
--   physical_effort                   2026-08-29   3.766666571299235
--   stair_speed_down                  2026-08-29   0.29255080223083496
--   stair_speed_up                    2026-08-29   0.23211338619391123
--   walking_speed                     2026-08-29   3.5279999999999996
--
-- 值本身没错（正常路径同样 round 到 3 位），只是精度没收敛。本迁移把它们对齐。
--
-- 为什么不能靠"重新推一次"来自愈：HAE 只推当天（or 最近几天），08-28/08-29 这些历史天
-- 不会再被推送，UPSERT 永远轮不到它们 —— 所以必须一次性 UPDATE。
--
-- ⚠️ 反过来的情况（**值本身算错了**，比如 08-29 那 6 个活动类指标整天缺失）无法用 SQL 修：
--    原始 payload 没有留档，只能重新导出历史。这也是"不留 payload 审计"的代价。
--
-- 幂等：WHERE 里带 `<> ROUND(...)`，重复执行无副作用。
--
-- 执行：npx wrangler d1 execute hae-health --remote --file scripts/migrate-2026-09-17-round-precision.sql

-- ① 指标点：正常路径的精度是 3 位小数（见 worker.js 的 Math.round(qty*1000)/1000）
UPDATE metric_points SET qty = ROUND(qty, 3)
 WHERE qty IS NOT NULL AND qty <> ROUND(qty, 3);

-- ② 锻炼：duration_min / kcal 现在收敛到 1 位小数（与 avg_hr / max_hr 一致）。
--    旧行是 71.96487963199615 / 361.36192551290105 这种，API 会原样吐给调用方。
UPDATE workouts
   SET duration_min = ROUND(duration_min, 1),
       kcal         = ROUND(kcal, 1)
 WHERE (duration_min IS NOT NULL AND duration_min <> ROUND(duration_min, 1))
    OR (kcal         IS NOT NULL AND kcal         <> ROUND(kcal, 1));
