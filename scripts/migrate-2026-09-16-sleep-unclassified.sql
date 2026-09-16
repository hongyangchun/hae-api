-- 补齐历史睡眠的「未分类」槽位（幂等，可重复执行）
--
-- 背景：Apple 的 asleepUnspecified（未分类睡眠）以前只作为 totalSleep 的兜底别名
-- 存在，从未单独入库。服务端修好后，只有「修复之后新推来的」数据才会带 unclassified，
-- 历史天数仍然缺这一槽 —— 于是 /api/query?name=sleep_analysis 只返回 6 个槽，
-- 而仪表盘是前端按「总时长 - 已分类」现推的，两边不一致。
--
-- 这里把历史天数也补上，推导口径与 worker.js 的 sleepSlotValues() 完全一致：
--     unclassified = max(0, total - (deep + rem + core))
--
-- 说明：HAE 汇总式睡眠点里 total - 已分类 恰好等于 asleep，两种口径实测等价
-- （2026-09-14 total 6.4039 = deep 0.5829 + rem 1.0659 + core 4.7551，asleep 0；
--   2026-09-10 total 6.07，已分类 4.36，asleep 1.71）。故回填不会引入新的口径。
--
-- INSERT OR IGNORE 依赖 (metric, date, slot) 唯一约束：已由新代码写入的行不会被覆盖，
-- 重复执行无副作用。

INSERT OR IGNORE INTO metric_points (metric, date, slot, qty, units)
SELECT 'sleep_analysis', t.date, 'unclassified',
       ROUND(CASE WHEN t.total - COALESCE(c.classified, 0) < 0
                  THEN 0 ELSE t.total - COALESCE(c.classified, 0) END, 3),
       'hr'
  FROM (SELECT date, qty AS total
          FROM metric_points
         WHERE metric = 'sleep_analysis' AND slot = 'total') t
  LEFT JOIN (SELECT date, SUM(qty) AS classified
               FROM metric_points
              WHERE metric = 'sleep_analysis' AND slot IN ('deep', 'rem', 'core')
              GROUP BY date) c
    ON c.date = t.date;

-- 回填结果自检：应输出每槽位天数，unclassified 天数应与 total 一致
SELECT slot, COUNT(*) AS n, MIN(date) AS first_day, MAX(date) AS last_day
  FROM metric_points
 WHERE metric = 'sleep_analysis'
 GROUP BY slot ORDER BY slot;
