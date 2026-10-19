#!/bin/sh
# archive_command of Postgres (guide step 8.6, ADR 0042). Copies a finished WAL segment, or a
# history or backup file, compressed into the archive: first under a temporary name, flushed to
# disk, then renamed, so the archive never holds half a file. A file that is in the archive
# already counts as archived only when its content is the same. On a failure Postgres keeps the
# segment and tries again.
#
# postgresql.conf: archive_command = '/backup/archive-wal.sh %p %f'
set -eu

source_path=$1
name=$2
archive=${PG_ARCHIVE_DIR:-/var/lib/postgresql/archive}
target="$archive/$name.gz"

if [ -f "$target" ]; then
  # The same file again, for example after a crash right after the rename.
  if gunzip -c "$target" | cmp -s - "$source_path"; then
    exit 0
  fi
  echo "archive-wal: $target exists with other content" >&2
  exit 1
fi

partial="$target.partial"
gzip -c "$source_path" > "$partial"
sync "$partial"
mv "$partial" "$target"
sync "$archive"
