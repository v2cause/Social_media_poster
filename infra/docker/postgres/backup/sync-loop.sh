#!/bin/sh
# Runs sync-once.sh every BACKUP_SYNC_SECONDS seconds (guide step 8.6, ADR 0042). The interval
# bounds how much is lost when the host goes with its volumes: at most this much plus the
# archive_timeout of Postgres.
set -u

while true; do
  /backup/sync-once.sh || echo "backup-sync: the copy failed, next try in ${BACKUP_SYNC_SECONDS:-300} s" >&2
  sleep "${BACKUP_SYNC_SECONDS:-300}"
done
