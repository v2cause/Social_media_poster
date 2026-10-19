#!/bin/sh
# Copies the complete base backups and the WAL archive to the object storage of the backups
# (guide step 8.6, ADR 0042) and notes the time of the copy in postgres/last-sync. Files in the
# storage stay when they go locally; the bucket expires them with its own rules.
set -eu

endpoint="--endpoint-url=$BACKUP_S3_ENDPOINT"
target="s3://$BACKUP_S3_BUCKET/postgres"
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws "$endpoint" s3 sync /backups/base "$target/base" --exclude '*.partial/*' --only-show-errors
aws "$endpoint" s3 sync /archive "$target/archive" --exclude '*.partial' --only-show-errors
printf '%s\n' "$started" | aws "$endpoint" s3 cp - "$target/last-sync" --only-show-errors
