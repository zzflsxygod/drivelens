-- SPDX-License-Identifier: AGPL-3.0-or-later
-- DriveLens 数据库初始化（在 TeslaMate 数据库上执行一次，可重复执行）
-- 用法（在 TeslaMate 的 compose 目录下）：
--   docker compose exec -T database psql -U teslamate -d teslamate \
--     -v ro_pass="'你的密码'" < drivelens-init.sql
-- 作用：创建只读用户 drivelens_ro；TeslaMate 的表只给 SELECT；
--       只有独立的 drivelens schema（自定义地点名称、手动充电费用）可写（地点名称、手动费用、旅程）。不修改 TeslaMate 的任何表。

SELECT format('CREATE ROLE drivelens_ro LOGIN PASSWORD %s', :'ro_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drivelens_ro') \gexec
ALTER ROLE drivelens_ro PASSWORD :ro_pass;

GRANT CONNECT ON DATABASE teslamate TO drivelens_ro;
GRANT USAGE ON SCHEMA public TO drivelens_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drivelens_ro;
-- TeslaMate 升级后新建的表也自动可读（以 teslamate 用户创建的表）
ALTER DEFAULT PRIVILEGES FOR ROLE teslamate IN SCHEMA public GRANT SELECT ON TABLES TO drivelens_ro;

CREATE SCHEMA IF NOT EXISTS drivelens;
CREATE TABLE IF NOT EXISTS drivelens.address_aliases (
  address_id integer PRIMARY KEY REFERENCES public.addresses(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  updated_at timestamptz NOT NULL DEFAULT now());
GRANT USAGE ON SCHEMA drivelens TO drivelens_ro;
GRANT SELECT, INSERT, UPDATE, DELETE ON drivelens.address_aliases TO drivelens_ro;

-- v0.4.0：手动充电费用（TeslaMate 的 cost 为空时手动录入；优先级 手动 > TeslaMate）
CREATE TABLE IF NOT EXISTS drivelens.charge_costs (
  charging_process_id integer PRIMARY KEY REFERENCES public.charging_processes(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  note text,
  updated_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, UPDATE, DELETE ON drivelens.charge_costs TO drivelens_ro;

-- v0.6.0：旅程（把多段行程合并为一次旅程；只引用 TeslaMate 的 drives，不修改它）
CREATE TABLE IF NOT EXISTS drivelens.journeys (
  id serial PRIMARY KEY,
  car_id integer NOT NULL REFERENCES public.cars(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) > 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS drivelens.journey_drives (
  drive_id integer PRIMARY KEY REFERENCES public.drives(id) ON DELETE CASCADE,
  journey_id integer NOT NULL REFERENCES drivelens.journeys(id) ON DELETE CASCADE);
CREATE INDEX IF NOT EXISTS journey_drives_journey_id_idx ON drivelens.journey_drives (journey_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON drivelens.journeys, drivelens.journey_drives TO drivelens_ro;
GRANT USAGE ON SEQUENCE drivelens.journeys_id_seq TO drivelens_ro;

-- v0.6.1：忽略的旅程建议（记录被忽略建议里的行程，不修改 TeslaMate）
CREATE TABLE IF NOT EXISTS drivelens.dismissed_suggestions (
  drive_id integer PRIMARY KEY REFERENCES public.drives(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, DELETE ON drivelens.dismissed_suggestions TO drivelens_ro;
