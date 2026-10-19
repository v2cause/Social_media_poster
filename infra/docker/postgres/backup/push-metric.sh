#!/bin/sh
# Pushes the time of the last success of a backup job to the Pushgateway (guide step 8.7,
# ADR 0043), for the alerts BackupCopyStale, BaseBackupStale and BackupHeartbeatMissing. Without
# BACKUP_PUSHGATEWAY_URL it does nothing; a push that fails is logged and never fails the job.
# Usage: push-metric.sh <job>, with curl (AWS CLI image) or the wget of BusyBox (Alpine).
set -u

job=${1:?usage: push-metric.sh <job>}
url=${BACKUP_PUSHGATEWAY_URL:-}
[ -n "$url" ] || exit 0

target="${url%/}/metrics/job/$job"
body="# TYPE smp_backup_last_success_timestamp_seconds gauge
smp_backup_last_success_timestamp_seconds $(date +%s)
"
# The messages of curl and wget stay out of the log, since they may quote the URL.
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$body" | curl -fs -m 10 -H 'Content-Type: text/plain; version=0.0.4' \
    --data-binary @- -o /dev/null "$target" 2>/dev/null
else
  wget -q -T 10 -O /dev/null --header 'Content-Type: text/plain; version=0.0.4' \
    --post-data "$body" "$target" 2>/dev/null
fi
code=$?
if [ "$code" -ne 0 ]; then
  echo "push-metric: the success of $job did not reach the Pushgateway (exit $code)" >&2
fi
exit 0
