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
