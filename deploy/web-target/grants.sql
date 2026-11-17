\set ON_ERROR_STOP on
-- Run as the dedicated cluster administrator, only against planplan_web,
-- AFTER migrations were run as planplan_web_owner.
SELECT current_database() = 'planplan_web' AS correct_db \gset
\if :correct_db
REVOKE ALL ON DATABASE planplan_web FROM PUBLIC;
GRANT CONNECT ON DATABASE planplan_web TO planplan_web_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO planplan_web_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO planplan_web_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE schema_migrations FROM planplan_web_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO planplan_web_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO planplan_web_app;
ALTER DEFAULT PRIVILEGES FOR ROLE planplan_web_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO planplan_web_app;
ALTER DEFAULT PRIVILEGES FOR ROLE planplan_web_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO planplan_web_app;
-- A restored database retains its readiness guard. The runtime may read this
-- guard but must never be able to release an isolated/incomplete restore.
SELECT to_regclass('planplan_recovery.guard') IS NOT NULL AS has_recovery_guard \gset
\if :has_recovery_guard
GRANT USAGE ON SCHEMA planplan_recovery TO planplan_web_app;
GRANT SELECT ON TABLE planplan_recovery.guard TO planplan_web_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE planplan_recovery.guard FROM planplan_web_app;
\endif
\else
DO $$ BEGIN RAISE EXCEPTION 'Refusing grants outside planplan_web'; END $$;
\endif
