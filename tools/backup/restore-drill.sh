#!/usr/bin/env bash
# The restore drill (guide step 8.6, ADR 0042, docs/runbooks/backup-restore.md). In a compose
# project of its own, next to the local stack:
#   1. Postgres with WAL archiving, the base backups and the copy to the object storage start, the
#      migrations and the demo seed run, and a second base backup follows.
#   2. A row goes in, the time T is noted, a second row goes in, and the WAL is archived and copied.
#   3. The server is stopped and not used again. The newest base backup from before T and the WAL
#      archive come back from the object storage into new volumes, and a new server recovers them
#      up to T.
#   4. The restored server holds the first row and not the second, every table holds as many rows
#      as at T, the roles of the app sign in, and check:rls finds row-level security intact.
#   5. restore:mark-attempts gives every variant the publisher still has to send an open attempt
#      at T, as the runbook does before the publishers start again.
# It prints how long each part took and ends with code 0 only when every check passed.
#
# Run from the repository root after `pnpm build`, with .env: pnpm backup:drill
# DRILL_FILLER_MB=500 writes about that much into a table before the second base backup and as
# much again after it, so that the times show the throughput of each part.
# DRILL_KEEP=1 keeps the project and its volumes for a look afterwards.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
PROJECT=${DRILL_PROJECT:-smp-drill}
FILLER_MB=${DRILL_FILLER_MB:-0}
RUN=$(date -u +%Y%m%d%H%M%S)
PG_IMAGE=postgres:17.11-alpine
AWS_IMAGE=amazon/aws-cli:2.38.1
ORIGINAL="$PROJECT-postgres-1"
RESTORED="$PROJECT-restored"
DATA_VOLUME="${PROJECT}_restore-data"
FILES_VOLUME="${PROJECT}_restore-files"

if [ ! -f .env ]; then
  echo "restore-drill: .env is missing; copy .env.example first" >&2
  exit 1
fi
if ! [[ "$FILLER_MB" =~ ^[0-9]+$ ]]; then
  echo "restore-drill: DRILL_FILLER_MB must be a whole number of megabytes" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
. ./.env
set +a
BACKUP_BUCKET=${BACKUP_S3_BUCKET:-smp-backups}
ENV_DATABASE_URL=$DATABASE_URL
ENV_MIGRATION_DATABASE_URL=$MIGRATION_DATABASE_URL
ENV_DATABASE_SYSTEM_URL=$DATABASE_SYSTEM_URL

log() { printf '%s restore-drill: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
fail() {
  log "FAILED: $*" >&2
  exit 1
}
now_s() { date +%s; }
# Runs a command and shows its output only when it fails.
quietly() {
  local output
  if ! output=$("$@" 2>&1); then
    printf '%s\n' "$output" >&2
    return 1
  fi
}
compose() {
  PG_ARCHIVE_MODE=on BACKUP_SYNC_SECONDS=30 docker compose --progress quiet -p "$PROJECT" \
    -f compose.yaml -f tools/backup/drill.compose.yaml --profile backup "$@"
}
# psql as postgres inside a container, unaligned and without headers.
sql() {
  local container=$1
  shift
  docker exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$container" \
    psql -X -q -t -A -v ON_ERROR_STOP=1 -h 127.0.0.1 -U postgres -d smp "$@"
}
signs_in() {
  docker exec -e PGPASSWORD="$3" "$1" psql -X -q -t -A -h 127.0.0.1 -U "$2" -d smp -c 'SELECT 1' > /dev/null
}
# The port on 127.0.0.1 that Docker published for port 5432 of a container.
host_port() { docker port "$1" 5432/tcp | sed -n 's/^127\.0\.0\.1:\([0-9]*\)$/\1/p' | head -n 1; }
# A database URL of .env with host and port of a drill server instead of its own.
at_port() {
  local url
  url=$(sed -E "s#@[^@/]+/#@127.0.0.1:$2/#" <<< "$1")
  [[ "$url" == *"@127.0.0.1:$2/"* ]] || fail "a database URL in .env has no host and port to replace"
  printf '%s' "$url"
}
# aws s3 against the object storage of the project, with the volume of the restore files at /restore.
aws_s3() {
  docker run --rm --network "${PROJECT}_default" -v "$FILES_VOLUME:/restore" \
    -e AWS_ACCESS_KEY_ID="${BACKUP_S3_ACCESS_KEY_ID:-$S3_ACCESS_KEY_ID}" \
    -e AWS_SECRET_ACCESS_KEY="${BACKUP_S3_SECRET_ACCESS_KEY:-$S3_SECRET_ACCESS_KEY}" \
    -e AWS_DEFAULT_REGION="${BACKUP_S3_REGION:-us-east-1}" \
    "$AWS_IMAGE" --endpoint-url http://s3:8333 s3 "$@"
}
in_files() { docker run --rm -v "$FILES_VOLUME:/restore" --entrypoint sh "$PG_IMAGE" -c "$1"; }
size_mb() { in_files "du -sm '$1' | cut -f1"; }
# A table of about FILLER_MB megabytes of random text, in a schema the app does not use.
add_filler() {
  [ "$FILLER_MB" -gt 0 ] || return 0
  sql "$ORIGINAL" -c "SET client_min_messages TO warning" -c "CREATE SCHEMA IF NOT EXISTS drill" -c "CREATE TABLE drill.$1 AS
    SELECT g AS id, md5(random()::text) || md5(random()::text) || md5(random()::text) || md5(random()::text) AS payload
      FROM generate_series(1, $FILLER_MB * 6000) AS g"
}
base_backups() {
  compose exec -T -u postgres postgres-backup sh -c 'ls -1 /var/lib/postgresql/backups/base 2> /dev/null | grep -v "\.partial$" || true'
}
promoted() { [ "$(sql "$RESTORED" -c 'SELECT pg_is_in_recovery()' 2> /dev/null || true)" = "f" ]; }
remove_all() {
  docker rm -f "$RESTORED" > /dev/null 2>&1 || true
  compose down -v > /dev/null 2>&1 || true
  docker volume rm "$DATA_VOLUME" "$FILES_VOLUME" > /dev/null 2>&1 || true
}

cleanup() {
  local code=$?
  if [ "${DRILL_KEEP:-0}" = "1" ]; then
    log "kept: project $PROJECT, container $RESTORED, volumes $DATA_VOLUME and $FILES_VOLUME"
  else
    remove_all
  fi
  exit "$code"
}
trap cleanup EXIT

# 1. The stack with archiving, base backups and the copy to the object storage.
log "starting project $PROJECT"
remove_all
compose up -d --wait postgres s3 s3-init postgres-backup backup-sync || fail "the stack did not start"
for _ in $(seq 1 60); do
  [ -n "$(base_backups)" ] && break
  sleep 2
done
[ -n "$(base_backups)" ] || fail "no base backup after the start"
log "first base backup done"

PG_PORT=$(host_port "$ORIGINAL")
[ -n "$PG_PORT" ] || fail "Postgres published no port"
export DATABASE_URL MIGRATION_DATABASE_URL DATABASE_SYSTEM_URL
DATABASE_URL=$(at_port "$ENV_DATABASE_URL" "$PG_PORT")
MIGRATION_DATABASE_URL=$(at_port "$ENV_MIGRATION_DATABASE_URL" "$PG_PORT")
DATABASE_SYSTEM_URL=$(at_port "$ENV_DATABASE_SYSTEM_URL" "$PG_PORT")
quietly pnpm --silent --filter @smp/db migrate:deploy || fail "the migrations did not run"
quietly pnpm --silent db:seed || fail "the seed did not run"
add_filler in_backup
log "migrations, demo seed and ${FILLER_MB} MB of filler done"

started=$(now_s)
quietly compose exec -T -u postgres postgres-backup /backup/base-backup.sh || fail "the second base backup failed"
backup_seconds=$(($(now_s) - started))
db_mb=$(sql "$ORIGINAL" -c "SELECT pg_database_size('smp') / 1048576")
log "second base backup of ${db_mb} MB done in ${backup_seconds} s"
add_filler replayed

# 2. The rows before and after T, the counts at T, and the archive copied away.
sql "$ORIGINAL" -c "INSERT INTO organization (id, name, updated_at) VALUES (gen_random_uuid(), 'Restore drill $RUN before', now())"
# The rows of every table, counted as postgres, whom row-level security does not limit.
COUNTS_SQL="SELECT string_agg(format('%I.%I', table_schema, table_name) || '=' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', table_schema, table_name), false, true, '')))[1]::text, ' ' ORDER BY table_schema, table_name) FROM information_schema.tables WHERE table_schema IN ('public', 'drill') AND table_type = 'BASE TABLE'"
counts_at_target=$(sql "$ORIGINAL" -c "$COUNTS_SQL")
sleep 1
# T for the recovery and the mark in ISO 8601, and T as the name of a base backup, which is its
# UTC start time.
IFS='|' read -r TARGET target_stamp <<< "$(sql "$ORIGINAL" -F '|' -c "SELECT to_char(t, 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"+00:00\"'), to_char(t, 'YYYYMMDD\"T\"HH24MISS\"Z\"') FROM (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS t) AS s")"
[ -n "$TARGET" ] && [ -n "$target_stamp" ] || fail "the target time could not be read"
sleep 1
sql "$ORIGINAL" -c "INSERT INTO organization (id, name, updated_at) VALUES (gen_random_uuid(), 'Restore drill $RUN after', now())"
segment=$(sql "$ORIGINAL" -c "SELECT pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 120); do
  archived=$(sql "$ORIGINAL" -c "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
  if [[ "$archived" > "$segment" || "$archived" == "$segment" ]]; then
    break
  fi
  sleep 1
done
[[ "$archived" > "$segment" || "$archived" == "$segment" ]] || fail "WAL segment $segment was not archived"
[ "$(sql "$ORIGINAL" -c "SELECT failed_count FROM pg_stat_archiver")" = "0" ] || fail "the archiving failed in between"
quietly compose exec -T backup-sync /backup/sync-once.sh || fail "the copy to the object storage failed"
log "target time $TARGET, WAL up to $segment archived and copied"

# 3. The server goes; the base backup and the archive come back from the object storage.
quietly compose stop postgres-backup backup-sync postgres || fail "the original server did not stop"
log "original server stopped"
docker volume create "$DATA_VOLUME" > /dev/null
docker volume create "$FILES_VOLUME" > /dev/null
started=$(now_s)
listing=$(aws_s3 ls "s3://$BACKUP_BUCKET/postgres/base/") || fail "the base backups in the object storage could not be listed"
# The newest base backup that started before T.
backup=$(awk '$1 == "PRE" { sub("/$", "", $2); print $2 }' <<< "$listing" | awk -v t="$target_stamp" '$0 <= t' | sort | tail -n 1)
[ -n "$backup" ] || fail "no base backup before $TARGET in the object storage"
quietly aws_s3 sync "s3://$BACKUP_BUCKET/postgres/base/$backup" "/restore/base/$backup" --only-show-errors ||
  fail "the download of base backup $backup failed"
quietly aws_s3 sync "s3://$BACKUP_BUCKET/postgres/archive" /restore/archive --only-show-errors ||
  fail "the download of the archive failed"
download_seconds=$(($(now_s) - started))
base_mb=$(size_mb "/restore/base/$backup")
archive_mb=$(size_mb /restore/archive)
log "base backup $backup (${base_mb} MB) and archive (${archive_mb} MB) downloaded in ${download_seconds} s"

started=$(now_s)
docker run --rm -v "$DATA_VOLUME:/var/lib/postgresql/data" -v "$FILES_VOLUME:/restore" \
  -v "$ROOT/infra/docker/postgres/backup:/backup:ro" --entrypoint sh "$PG_IMAGE" -c \
  "chown -R postgres:postgres /var/lib/postgresql/data /restore && chmod 0700 /var/lib/postgresql/data && gosu postgres /backup/restore.sh '/restore/base/$backup' /restore/archive '$TARGET'" > /dev/null ||
  fail "the base backup could not be prepared"
prepare_seconds=$(($(now_s) - started))
log "base backup unpacked and checked against its manifest in ${prepare_seconds} s"

started=$(now_s)
docker run -d --name "$RESTORED" -p 127.0.0.1::5432 \
  -v "$DATA_VOLUME:/var/lib/postgresql/data" -v "$FILES_VOLUME:/restore:ro" \
  -v "$ROOT/infra/docker/postgres/backup:/backup:ro" "$PG_IMAGE" > /dev/null
for _ in $(seq 1 600); do
  promoted && break
  [ "$(docker inspect -f '{{.State.Running}}' "$RESTORED")" = "true" ] || break
  sleep 1
done
promoted || {
  docker logs "$RESTORED" 2>&1 | tail -20 >&2
  fail "the restored server did not finish its recovery"
}
recovery_seconds=$(($(now_s) - started))
start_lsn=$(in_files "tar -xzOf '/restore/base/$backup/base.tar.gz' backup_label" |
  sed -n 's#^START WAL LOCATION: \([0-9A-F]*/[0-9A-F]*\) .*#\1#p')
replayed_mb=$(sql "$RESTORED" -c "SELECT round(pg_wal_lsn_diff(pg_current_wal_lsn(), '$start_lsn') / 1048576)")
log "recovered up to the target and promoted in ${recovery_seconds} s, ${replayed_mb} MB of WAL replayed"

# 4. The checks.
before=$(sql "$RESTORED" -c "SELECT count(*) FROM organization WHERE name = 'Restore drill $RUN before'")
after=$(sql "$RESTORED" -c "SELECT count(*) FROM organization WHERE name = 'Restore drill $RUN after'")
[ "$before" = "1" ] || fail "the row before the target is missing"
[ "$after" = "0" ] || fail "the row after the target came back"
counts_restored=$(sql "$RESTORED" -c "$COUNTS_SQL")
[ "$counts_restored" = "$counts_at_target" ] || fail "the tables differ from the time of the target: $counts_restored"
timeline=$(sql "$RESTORED" -c 'SELECT timeline_id FROM pg_control_checkpoint()')
signs_in "$RESTORED" app_user "$APP_USER_PASSWORD" || fail "app_user cannot sign in"
signs_in "$RESTORED" app_system "$APP_SYSTEM_PASSWORD" || fail "app_system cannot sign in"
signs_in "$RESTORED" app_migrator "$APP_MIGRATOR_PASSWORD" || fail "app_migrator cannot sign in"
RESTORED_PORT=$(host_port "$RESTORED")
[ -n "$RESTORED_PORT" ] || fail "the restored server published no port"
MIGRATION_DATABASE_URL=$(at_port "$ENV_MIGRATION_DATABASE_URL" "$RESTORED_PORT")
quietly pnpm --silent check:rls || fail "check:rls failed on the restored server"
tables=$(wc -w <<< "$counts_restored" | tr -d ' ')

# 5. The mark of the variants the publisher still has to send.
DATABASE_SYSTEM_URL=$(at_port "$ENV_DATABASE_SYSTEM_URL" "$RESTORED_PORT")
quietly pnpm --silent restore:mark-attempts --since "$TARGET" || fail "restore:mark-attempts failed"
IFS='|' read -r pending unmarked <<< "$(sql "$RESTORED" -F '|' -c "SELECT count(*), count(*) FILTER (WHERE NOT EXISTS (
    SELECT 1 FROM publish_attempt a
     WHERE a.variant_id = v.id AND a.outcome IN ('STARTED', 'UNKNOWN') AND a.started_at <= '$TARGET'))
  FROM post_variant v WHERE v.status IN ('SCHEDULED', 'QUEUED', 'PUBLISHING', 'RETRYING')")"
[ -n "$pending" ] && [ "$unmarked" = "0" ] || fail "$unmarked of $pending pending variants have no open attempt at T"

log "passed: the row before T is there and the one after it is not, $tables tables as at T, timeline $timeline, the roles of the app sign in, row-level security intact, $pending pending variants marked"
log "times: base backup ${backup_seconds} s for ${db_mb} MB, download ${download_seconds} s for $((base_mb + archive_mb)) MB, unpacking and checking ${prepare_seconds} s for ${base_mb} MB, recovery ${recovery_seconds} s for ${replayed_mb} MB of WAL"
