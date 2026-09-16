-- HAE 健康数据表结构（D1 / SQLite）
--
-- 注意：这里只存「原始指标」。有一类指标是读时计算的派生指标，不落库
--   vo2_max_est  心肺耐力估算（Uth 公式 15×HRmax/HRrest，依赖 90 天滚动窗口，
--                落库后每来一条新数据都要重算历史，故做成 /api/query 的一个分支）
-- 详见 docs/design-notes.md 第三节第 6 小节。

-- 指标数据：一天一格点（HAE 聚合 = Days）
-- slot 用于区分同一指标的多值字段：
--   普通指标（含 resting_heart_rate / heart_rate_variability / walking_heart_rate_average）-> qty
--   仅 heart_rate -> avg / min / max
--   sleep_analysis -> total / deep / rem / core / unclassified / awake / inbed（单位: 小时）
--     其中 unclassified = Apple 的「未分类睡眠」(asleepUnspecified)，
--     total 应等于 deep + rem + core + unclassified
--     历史天数的 unclassified 由 scripts/migrate-2026-09-16-sleep-unclassified.sql 回填
CREATE TABLE IF NOT EXISTS metric_points (
  metric TEXT NOT NULL,
  date   TEXT NOT NULL,           -- YYYY-MM-DD（Asia/Shanghai）
  slot   TEXT NOT NULL DEFAULT 'qty',
  qty    REAL,
  units  TEXT,
  PRIMARY KEY (metric, date, slot)
);

-- 锻炼记录：一条锻炼一行
CREATE TABLE IF NOT EXISTS workouts (
  id             TEXT PRIMARY KEY,  -- HAE workout.id 或 name|start
  name           TEXT,
  day            TEXT,              -- YYYY-MM-DD（Asia/Shanghai）
  start          TEXT,
  end            TEXT,
  duration_min   REAL,
  kcal           REAL,
  distance       REAL,
  distance_units TEXT,
  avg_hr         REAL,
  max_hr         REAL,
  source         TEXT,
  raw            TEXT               -- 原始 JSON，留档
);

CREATE INDEX IF NOT EXISTS idx_metric_date ON metric_points (metric, date);
CREATE INDEX IF NOT EXISTS idx_workouts_day ON workouts (day);
