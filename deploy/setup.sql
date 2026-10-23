-- SPDX-License-Identifier: AGPL-3.0-or-later
-- DriveLens one-time database setup. Run it on the TeslaMate database as TeslaMate's database admin; safe to re-run.
-- Usage (in TeslaMate's docker compose directory):
--   docker compose exec -T database psql -U teslamate -d teslamate \
--     -v ro_pass='a-strong-password' < setup.sql
--
-- What it does:
--   * creates the login role drivelens_ro with SELECT only on TeslaMate's tables (public schema) —
--     DriveLens never writes to TeslaMate's tables;
--   * creates a separate drivelens schema (owned by drivelens_ro when it is new) and grants drivelens_ro USAGE and CREATE
--     on it, also when an admin created the schema earlier; the API creates / upgrades its own tables there
--     on every start (idempotent), e.g. place aliases, costs, journeys, the web-push tables (push_subscriptions, push_state)
--     and the device-auth tables (devices, pairing_codes; API 0.14.0+);
--   * hands drivelens tables that an admin created with the older SQL files over to drivelens_ro, so the API can
--     upgrade them itself (e.g. API 0.14.0 adds push_subscriptions.device_id).
-- Upgrading to API 0.14.0 from an install made with older SQL files: re-run this file once (or just the GRANT on schema
-- drivelens and the ownership handover below), then restart the API; otherwise device auth stays disabled.
-- (Older drivelens-init.sql / drivelens-v0.x.sql files are no longer needed.)

SELECT format('CREATE ROLE drivelens_ro LOGIN PASSWORD %L', :'ro_pass')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drivelens_ro') \gexec
SELECT format('ALTER ROLE drivelens_ro PASSWORD %L', :'ro_pass') \gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO drivelens_ro', current_database()) \gexec
GRANT USAGE ON SCHEMA public TO drivelens_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO drivelens_ro;
-- tables added by future TeslaMate upgrades (created by the current admin role) become readable automatically
SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT ON TABLES TO drivelens_ro', current_user) \gexec
-- lets drivelens tables reference TeslaMate rows with foreign keys (DriveLens data is cleaned up when TeslaMate deletes a
-- drive / charge / car); this grants no write access
GRANT REFERENCES ON public.cars, public.addresses, public.drives, public.charging_processes TO drivelens_ro;

CREATE SCHEMA IF NOT EXISTS drivelens AUTHORIZATION drivelens_ro;
GRANT USAGE, CREATE ON SCHEMA drivelens TO drivelens_ro;
-- tables created by an admin with the older drivelens-init.sql / drivelens-v0.x.sql files: the API role becomes their
-- owner (only objects in the drivelens schema; TeslaMate's tables are not touched)
SELECT format('ALTER TABLE drivelens.%I OWNER TO drivelens_ro', tablename) FROM pg_tables
WHERE schemaname = 'drivelens' AND tableowner <> 'drivelens_ro' \gexec
