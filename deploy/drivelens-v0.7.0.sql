-- SPDX-License-Identifier: AGPL-3.0-or-later
-- DriveLens v0.7.0 升级：旅程封面 + 天气缓存（可重复执行，不需要密码）
-- 只修改 drivelens schema，不动 TeslaMate 的任何表。
-- docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.7.0.sql

-- 1) 旅程封面（地图截图，JPEG data URL）
ALTER TABLE drivelens.journeys ADD COLUMN IF NOT EXISTS cover_image text;
ALTER TABLE drivelens.journeys ADD COLUMN IF NOT EXISTS cover_updated_at timestamptz;

-- 2) Open-Meteo 历史天气缓存（按 0.1° 网格 × 小时）
CREATE TABLE IF NOT EXISTS drivelens.weather_hourly (
  lat_key smallint NOT NULL,      -- round(latitude * 10)
  lng_key smallint NOT NULL,      -- round(longitude * 10)
  hour timestamptz NOT NULL,
  temp_c real,
  precip_mm real,
  source text NOT NULL DEFAULT 'archive',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lat_key, lng_key, hour));

-- 3) 授权（journeys 的 UPDATE 已在 v0.6.0 授予，这里再确认一次）
GRANT SELECT, INSERT, UPDATE, DELETE ON drivelens.journeys TO drivelens_ro;
GRANT SELECT, INSERT, UPDATE ON drivelens.weather_hourly TO drivelens_ro;
