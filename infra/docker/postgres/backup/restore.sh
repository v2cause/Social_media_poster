#!/bin/sh
# Prepares an empty data directory for a recovery (guide step 8.6, ADR 0042): unpacks a base
# backup with its WAL, checks it against its manifest and asks for a recovery from the given
# archive, to the given time or, without one, to the end of the archive. The next start of
# Postgres on PGDATA runs the recovery and then takes a new timeline. Whether that server archives
# its WAL decides its start: docs/runbooks/backup-restore.md starts it without archiving first.
#
# Usage: restore.sh <directory of a base backup> <archive directory> [target time]
# The target time is ISO 8601 with a numeric offset, e.g. 2026-10-19T01:23:45+00:00.
set -eu

backup=$1
archive=$2
target=${3:-}
data=${PGDATA:-/var/lib/postgresql/data}

case "$target" in
  *[Zz])
    # Postgres refuses the abbreviation in recovery_target_time when it starts.
    echo "restore: give the target time with a numeric offset such as +00:00 instead of Z" >&2
    exit 1
    ;;
esac
if [ -n "$(ls -A "$data" 2>/dev/null)" ]; then
  echo "restore: $data is not empty" >&2
  exit 1
fi
tar -xzf "$backup/base.tar.gz" -C "$data"
mkdir -p "$data/pg_wal"
tar -xzf "$backup/pg_wal.tar.gz" -C "$data/pg_wal"
# Every file with its size and SHA-256 checksum, and the WAL from the start to the end of the backup.
pg_verifybackup --quiet --manifest-path="$backup/backup_manifest" "$data"
{
  echo "restore_command = '/backup/restore-wal.sh %f %p $archive'"
  if [ -n "$target" ]; then
    echo "recovery_target_time = '$target'"
    echo "recovery_target_action = 'promote'"
  fi
} >> "$data/postgresql.auto.conf"
touch "$data/recovery.signal"
chmod 0700 "$data"
echo "restore: $backup checked and prepared in $data, recovery to ${target:-the end of the archive}"
