#!/bin/sh
# The database roles of the production template (guide step 8.9, ADR 0045). The one-shot service
# "db-roles" runs this before the migrations at every deploy, as the superuser over TLS. Every
# step can run again: roles that exist get their password, attributes and settings anew, so a
# changed password file takes effect with the next deploy.
#
#   app_migrator          owns the database and runs the migrations
#   app_user, app_system  groups without login that hold the privileges of the migrations
#   svc_<service>         the login of a service with row-level security, member of app_user
#   svc_<service>_system  its login for @SystemScope() methods, BYPASSRLS, member of app_system
#   svc_backup            replication only, for the base backups
#
# BYPASSRLS belongs to the system logins themselves: Postgres does not pass it on through a group,
# and the group app_system keeps none, so no member gains it with SET ROLE. Settings of a role do
# not pass on either; every login gets its own timeouts and a limit of connections.
set -eu

secrets=/run/secrets
export PGHOST=postgres PGUSER=postgres PGDATABASE=postgres
export PGSSLMODE=verify-full PGSSLROOTCERT=/run/configs/internal-ca.crt
PGPASSWORD=$(cat "$secrets/postgres_password")
export PGPASSWORD

# role kind connection-limit: kind is user (row-level security), system (BYPASSRLS) or backup.
logins='
svc_api user 50
svc_api_system system 25
svc_scheduler user 25
svc_scheduler_system system 25
svc_publisher user 50
svc_publisher_system system 25
svc_media user 25
svc_notify user 25
svc_billing user 25
svc_billing_system system 25
svc_backup backup 5
'

{
  # A failing statement is not logged with its text, which may hold a password.
  echo "SET log_min_error_statement = 'panic';"
  echo "SET log_statement = 'none';"
  cat <<'SQL'
SELECT 'CREATE ROLE app_user NOLOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user')
\gexec
SELECT 'CREATE ROLE app_system NOLOGIN' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_system')
\gexec
SELECT 'CREATE ROLE app_migrator' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_migrator')
\gexec
ALTER ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE app_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
\set password `cat /run/secrets/pg_password_app_migrator`
ALTER ROLE app_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD :'password';
SELECT 'CREATE DATABASE smp OWNER app_migrator' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'smp')
\gexec
REVOKE CONNECT ON DATABASE smp FROM PUBLIC;
GRANT CONNECT ON DATABASE smp TO app_user, app_system;
SQL
  printf '%s\n' "$logins" | while read -r role kind limit; do
    [ -n "$role" ] || continue
    case $kind in
      user) attributes='NOBYPASSRLS NOREPLICATION'; group=app_user; timeout=30s ;;
      system) attributes='BYPASSRLS NOREPLICATION'; group=app_system; timeout=5min ;;
      backup) attributes='NOBYPASSRLS REPLICATION'; group=''; timeout=0 ;;
    esac
    cat <<SQL
SELECT 'CREATE ROLE $role' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$role')
\\gexec
\\set password \`cat $secrets/pg_password_$role\`
ALTER ROLE $role LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE $attributes CONNECTION LIMIT $limit PASSWORD :'password';
ALTER ROLE $role SET statement_timeout = '$timeout';
ALTER ROLE $role SET idle_in_transaction_session_timeout = '60s';
SQL
    if [ -n "$group" ]; then
      echo "GRANT $group TO $role;"
    fi
  done
} | psql --no-psqlrc --quiet -v ON_ERROR_STOP=1

echo "db-roles: roles and database are in place"
