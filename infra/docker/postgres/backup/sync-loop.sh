#!/bin/sh
# Runs sync-once.sh every BACKUP_SYNC_SECONDS seconds (guide step 8.6, ADR 0042). The interval
# bounds how much is lost when the host goes with its volumes: at most this much plus the
# archive_timeout of Postgres. A good copy reports its time to the Pushgateway (guide step 8.7).
set -u

while true; do
  if /backup/sync-once.sh; then
    /backup/push-metric.sh backup-sync
  else
    echo "backup-sync: the copy failed, next try in ${BACKUP_SYNC_SECONDS:-300} s" >&2
  fi
  sleep "${BACKUP_SYNC_SECONDS:-300}"
done
