import { uuidv7 } from 'uuidv7';

import type { Prisma } from '../generated/prisma/client';

// One row per key and scope in feature_flag (guide step 6.1). A unique index over the nullable
// scope columns would need NULLS NOT DISTINCT, which Prisma cannot express, so the writers of a
// key and scope queue behind a transaction-level advisory lock and update the row or add it.

export interface FlagScope {
  organizationId: string | null;
  workspaceId: string | null;
}

/** A transaction of the tenant client or of the system client. */
interface RawWriter {
  $executeRaw(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): PromiseLike<number>;
}

export async function setFlag(tx: RawWriter, key: string, scope: FlagScope, enabled: boolean): Promise<void> {
  const { organizationId, workspaceId } = scope;
  const lockKey = `feature_flag:${key}:${organizationId ?? '-'}:${workspaceId ?? '-'}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  const updated = await tx.$executeRaw`
    UPDATE feature_flag SET enabled = ${enabled}, updated_at = now()
     WHERE key = ${key}
       AND organization_id IS NOT DISTINCT FROM ${organizationId}::uuid
       AND workspace_id IS NOT DISTINCT FROM ${workspaceId}::uuid`;
  if (updated === 0) {
    await tx.$executeRaw`
      INSERT INTO feature_flag (id, key, organization_id, workspace_id, enabled, updated_at)
      VALUES (${uuidv7()}::uuid, ${key}, ${organizationId}::uuid, ${workspaceId}::uuid, ${enabled}, now())`;
  }
}
