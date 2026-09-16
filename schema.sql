-- HAE 健康数据表结构（D1 / SQLite）

-- 指标数据：一天一格点（HAE 聚合 = Days）
-- slot 用于区分同一指标的多值字段：
--   普通指标（含 resting_heart_rate / heart_rate_variability / walking_heart_rate_average）-> qty
--   仅 heart_rate -> avg / min / max
--   sleep_analysis -> total / deep / rem / core / unclassified / awake / inbed（单位: 小时）
--     其中 unclassified = Apple 的「未分类睡眠」(asleepUnspecified)，
--     total 应等于 deep + rem + core + unclassified
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
