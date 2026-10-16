import type { ReauthMark } from '@smp/core';

import type { TenantTransaction } from '../tenant-context';

// A connection that needs a new grant (guide step 4.9): NEEDS_REAUTH from ACTIVE or EXPIRING, and
// the scheduled variants of its accounts carry the failure code REAUTH_REQUIRED as a mark. They
// keep their status; the publish job fails them at their time unless the account is connected
// again before, which takes the mark off.

export async function markNeedsReauth(
  tx: TenantTransaction,
  workspaceId: string,
  connectionId: string,
  reason: string,
): Promise<ReauthMark> {
  const { count } = await tx.socialConnection.updateMany({
    where: { id: connectionId, workspaceId, status: { in: ['ACTIVE', 'EXPIRING'] } },
    data: { status: 'NEEDS_REAUTH', statusReason: reason, version: { increment: 1 } },
  });
  if (count === 0) {
    return { changed: false, scheduledVariants: 0 };
  }
  const marked = await tx.postVariant.updateMany({
    where: { workspaceId, status: 'SCHEDULED', socialAccount: { connectionId } },
    data: { failureCode: 'REAUTH_REQUIRED' },
  });
  return { changed: true, scheduledVariants: marked.count };
}

/** A new grant takes the mark off the scheduled variants of its accounts. */
export async function clearReauthMarks(
  tx: TenantTransaction,
  workspaceId: string,
  connectionId: string,
): Promise<void> {
  await tx.postVariant.updateMany({
    where: {
      workspaceId,
      status: 'SCHEDULED',
      failureCode: 'REAUTH_REQUIRED',
      socialAccount: { connectionId },
    },
    data: { failureCode: null },
  });
}
