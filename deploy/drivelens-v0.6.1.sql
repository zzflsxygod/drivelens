-- DriveLens v0.6.1 升级：只新建「已忽略的旅程建议」表并授权（可重复执行，不需要密码）
-- docker compose exec -T database psql -U teslamate -d teslamate < drivelens-v0.6.1.sql
CREATE TABLE IF NOT EXISTS drivelens.dismissed_suggestions (
  drive_id integer PRIMARY KEY REFERENCES public.drives(id) ON DELETE CASCADE,
  dismissed_at timestamptz NOT NULL DEFAULT now());
GRANT SELECT, INSERT, DELETE ON drivelens.dismissed_suggestions TO drivelens_ro;
