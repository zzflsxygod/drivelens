-- DriveLens 一次性数据库设置（在 TeslaMate 数据库上以 TeslaMate 的数据库管理员执行；可重复执行）
-- 用法（在 TeslaMate 的 docker compose 目录下）：
--   docker compose exec -T database psql -U teslamate -d teslamate \
--     -v ro_pass='换成一个强密码' < setup.sql
--
-- 作用：
--   * 创建登录角色 drivelens_ro；对 TeslaMate 的表（public schema）只有 SELECT —— DriveLens 永远不会写 TeslaMate 的表；
--   * 创建独立的 drivelens schema 并交给 drivelens_ro 所有，API 启动时会在其中自动建表/升级（幂等）。
-- 旧版本的 drivelens-init.sql / drivelens-v0.x.sql 已不再需要（已执行过的也无需改动）。

SELECT format('CREATE ROLE drivelens_ro LOGIN PASSWORD %L', :'ro_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drivelens_ro') \gexec
SELECT format('ALTER ROLE drivelens_ro PASSWORD %L', :'ro_pass') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO drivelens_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO drivelens_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drivelens_ro;
-- TeslaMate 升级后新建的表也自动可读（由当前管理员角色创建的表）
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO drivelens_ro', current_user) \gexec
-- 允许 drivelens 表用外键引用 TeslaMate 的行（删除 TeslaMate 的行程/充电/车辆时 DriveLens 的数据随之清理；不赋予任何写权限）
GRANT REFERENCES ON public.cars, public.addresses, public.drives, public.charging_processes TO drivelens_ro;

CREATE SCHEMA IF NOT EXISTS drivelens AUTHORIZATION drivelens_ro;
GRANT USAGE, CREATE ON SCHEMA drivelens TO drivelens_ro;
