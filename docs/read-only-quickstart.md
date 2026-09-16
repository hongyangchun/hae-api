# 健康数据读取对接（极简版 · 只读）

数据源：`https://hae.qiaclass.com`（iPhone Health Auto Export 实时推送的云端库，只读即可，推送由既有链路负责）
鉴权：HTTP header `api-key: <READ_KEY>`（key 由用户单独提供，勿写入代码仓库/聊天记录）

## 端点
- `GET /api/metrics` → 指标清单（名称/单位/覆盖日期范围）
- `GET /api/query?name=X&from=YYYY-MM-DD&to=YYYY-MM-DD[&convert=kcal|km]` → 时间序列（闭区间）
- `GET /api/workouts?from=YYYY-MM-DD&to=YYYY-MM-DD` → 锻炼记录

## 响应要点
- `/api/query` 返回 `{"units":..., "points":[{"date":"YYYY-MM-DD","qty":..}]}`
- slot 语义：普通指标=`qty`；`heart_rate`=`avg/min/max`；`sleep_analysis`=`total/deep/rem/core/awake/inbed`（单位：小时）
- 常用指标名：sleep_analysis, resting_heart_rate, heart_rate_variability, blood_oxygen_saturation, active_energy, basal_energy_burned, step_count, walking_running_distance, apple_exercise_time, apple_stand_time, cycling_distance, weight_body_mass

## 必守规则（违反会失败或读错数）
1. 请求必须带自定义 User-Agent（如 `hae-fetch/1.0`）——Python 默认 UA 会被 403 拦截
2. 401=key 错误（截断/空格）；403=UA/防火墙
3. 睡眠日期=醒来那天早晨：查「昨晚睡眠」取**今天**的 sleep_analysis 点；过滤 total<1h 的白天残夜点（噪音）
4. 能量默认 kJ，必须加 `convert=kcal`；距离加 `convert=km`
5. 日期按 Asia/Shanghai 归天

## 验证命令
curl -H "api-key: $READ_KEY" -H "User-Agent: hae-fetch/1.0" "https://hae.qiaclass.com/api/query?name=step_count&from=2026-09-01&to=2026-09-05"
