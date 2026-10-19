#!/bin/sh
# restore_command of a recovery (guide step 8.6, ADR 0042): unpacks a file of the archive. A
# file that is missing ends the recovery, as Postgres expects.
#
# postgresql.auto.conf: restore_command = '/backup/restore-wal.sh %f %p /path/of/the/archive'
set -eu

name=$1
target_path=$2
archive=${3:-${PG_ARCHIVE_DIR:-/var/lib/postgresql/archive}}

if [ ! -f "$archive/$name.gz" ]; then
  exit 1
fi
gunzip -c "$archive/$name.gz" > "$target_path"
