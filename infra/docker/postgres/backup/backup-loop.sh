#!/bin/sh
# The schedule of the base backups (guide step 8.6, ADR 0042): one right after the start, then
# every BACKUP_INTERVAL_HOURS hours. A failed backup is logged and tried again an hour later; a
# good one reports its time to the Pushgateway (guide step 8.7).
set -u

interval_hours=${BACKUP_INTERVAL_HOURS:-24}
while true; do
  if /backup/base-backup.sh; then
    /backup/push-metric.sh postgres-backup
    sleep "$((interval_hours * 3600))"
  else
    echo "backup-loop: the base backup failed, next try in an hour" >&2
    sleep 3600
  fi
done
