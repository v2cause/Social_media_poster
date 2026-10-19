#!/bin/sh
# A base backup of the cluster (guide step 8.6, ADR 0042) into PG_BACKUP_DIR/base/<UTC time>: tar,
# compressed, with the WAL that makes it consistent and a manifest with SHA-256 checksums. After
# it only the newest BACKUP_KEEP backups stay, and the archive keeps the WAL from the start of the
# oldest of them on. pg_basebackup connects with PGHOST, PGUSER and PGPASSWORD.
set -eu

backups=${PG_BACKUP_DIR:-/var/lib/postgresql/backups}
archive=${PG_ARCHIVE_DIR:-/var/lib/postgresql/archive}
keep=${BACKUP_KEEP:-7}
stamp=$(date -u +%Y%m%dT%H%M%SZ)

mkdir -p "$backups/base"
work="$backups/base/$stamp.partial"
pg_basebackup --pgdata="$work" --format=tar --gzip --wal-method=stream --checkpoint=fast \
  --manifest-checksums=SHA256 --label="smp-$stamp" --no-password
mv "$work" "$backups/base/$stamp"
echo "base-backup: $stamp done"

# Only complete backups count; their names sort by time.
complete=$(ls -1 "$backups/base" | grep -v '\.partial$' | sort)
count=$(printf '%s\n' "$complete" | grep -c .)
if [ "$count" -gt "$keep" ]; then
  printf '%s\n' "$complete" | head -n "$((count - keep))" | while read -r old; do
    rm -rf "${backups:?}/base/$old"
    echo "base-backup: $old removed"
  done
fi

# The WAL before the start of the oldest remaining backup is no longer needed.
oldest=$(ls -1 "$backups/base" | grep -v '\.partial$' | sort | head -n 1)
start=$(tar -xzOf "$backups/base/$oldest/base.tar.gz" backup_label | sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]*\))$/\1/p')
if [ -n "$start" ]; then
  pg_archivecleanup -x .gz "$archive" "$start"
fi
