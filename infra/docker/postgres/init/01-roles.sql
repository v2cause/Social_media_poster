-- Runs once, on the first start of an empty data volume, as the superuser.
--
-- Creates the three database roles from the architecture (docs/ARCHITECTURE.md, section 6.3):
--   app_migrator  owns the databases and runs migrations only
--   app_user      runtime role of the API and the worker, subject to row-level security
--   app_system    bypasses row-level security, only for repository methods marked @SystemScope()
--
-- Passwords come from the container environment (see compose.yaml) and are never written here.

\getenv app_migrator_password APP_MIGRATOR_PASSWORD
\getenv app_user_password APP_USER_PASSWORD
\getenv app_system_password APP_SYSTEM_PASSWORD

CREATE ROLE app_migrator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app_migrator_password';
CREATE ROLE app_user LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app_user_password';
CREATE ROLE app_system LOGIN NOSUPERUSER BYPASSRLS PASSWORD :'app_system_password';

CREATE DATABASE smp OWNER app_migrator;
CREATE DATABASE smp_test OWNER app_migrator;
-- Shadow database for `prisma migrate dev`. Prisma creates it on demand, so the migrator
-- needs no CREATEDB privilege. Only app_migrator connects to it.
CREATE DATABASE smp_shadow OWNER app_migrator;

-- PUBLIC may connect to every database by default. Only the roles that need a database get it;
-- app_migrator keeps access to all three as their owner.
REVOKE CONNECT ON DATABASE smp, smp_test, smp_shadow FROM PUBLIC;
GRANT CONNECT ON DATABASE smp, smp_test TO app_user, app_system;

-- Session defaults against runaway queries and transactions left open by a crashed caller.
-- They apply to every new session of the role; a job that needs more raises them with SET LOCAL.
ALTER ROLE app_user SET statement_timeout = '30s';
ALTER ROLE app_user SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE app_system SET statement_timeout = '5min';
ALTER ROLE app_system SET idle_in_transaction_session_timeout = '60s';
