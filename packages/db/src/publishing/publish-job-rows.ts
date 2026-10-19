import type { MissedWindowBehavior, PublishJobVariant } from '@smp/core';

// What both stores of the publish job read the same way (guide step 8.5): the Prisma store of the
// other jobs and the node-postgres store of the publish worker.

/** The variant with the settings of its workspace, as lockForJob reads it in one statement. */
export interface LockedVariantRow {
  id: string;
  workspace_id: string;
  post_id: string;
  platform: PublishJobVariant['platform'];
  status: PublishJobVariant['status'];
  version: number;
  schedule_version: number;
  social_account_id: string | null;
  text: string;
  hashtags: string[];
  first_comment: string | null;
  link_url: string | null;
  scheduled_at: Date | null;
  queued_at: Date | null;
  lease_owner: string | null;
  lease_until: Date | null;
  dry_run: boolean | null;
  missed_window_behavior: MissedWindowBehavior | null;
}

/** A workspace without settings publishes for real and fails a missed window. */
export const toPublishJobVariant = (row: LockedVariantRow): PublishJobVariant => ({
  id: row.id,
  workspaceId: row.workspace_id,
  postId: row.post_id,
  platform: row.platform,
  status: row.status,
  version: row.version,
  scheduleVersion: row.schedule_version,
  socialAccountId: row.social_account_id,
  text: row.text,
  hashtags: row.hashtags,
  firstComment: row.first_comment,
  linkUrl: row.link_url,
  scheduledAt: row.scheduled_at,
  queuedAt: row.queued_at,
  leaseOwner: row.lease_owner,
  leaseUntil: row.lease_until,
  dryRun: row.dry_run ?? false,
  missedWindowBehavior: row.missed_window_behavior ?? 'FAIL',
});

/** SocialAccount.settings as an object; anything else counts as no settings. */
export const accountSettingsOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
