-- SPDX-License-Identifier: AGPL-3.0-or-later
-- DriveLens v0.6.0 升级：只新建旅程表并授权（可重复执行，不需要密码）
-- docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.6.0.sql
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
