-- DriveLens 数据库初始化（在 TeslaMate 数据库上执行一次，可重复执行）
-- 用法（在 TeslaMate 的 compose 目录下）：
--   docker compose exec -T database psql -U teslamate -d teslamate \
--     -v ro_pass="'你的密码'" < drivelens-init.sql
-- 作用：创建只读用户 drivelens_ro；TeslaMate 的表只给 SELECT；
--       只有独立的 drivelens schema（自定义地点名称）可写。不修改 TeslaMate 的任何表。

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
