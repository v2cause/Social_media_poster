-- Extensions used by the schema. Both are "trusted" extensions in PostgreSQL 13 and later,
-- so the database owner (app_migrator) can install them without superuser rights.
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Tables and sequences that app_migrator creates in later migrations are readable and
-- writable by the runtime roles. Row-level security is added in its own migration.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user, app_system;
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_user, app_system;
