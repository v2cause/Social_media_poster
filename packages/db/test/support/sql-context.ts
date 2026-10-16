import type { Client } from 'pg';

export interface SqlTenantContext {
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
  invitationTokenHash?: string;
}

/** Sets the context transaction-locally, as the tenant extension does, and runs fn inside. */
export async function inContext<T>(
  client: Client,
  context: SqlTenantContext,
  fn: () => Promise<T>,
): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query(
      `SELECT set_config('app.user_id', $1, true),
              set_config('app.organization_id', $2, true),
              set_config('app.workspace_id', $3, true),
              set_config('app.invitation_token_hash', $4, true)`,
      [
        context.userId ?? '',
        context.organizationId ?? '',
        context.workspaceId ?? '',
        context.invitationTokenHash ?? '',
      ],
    );
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** The sorted ids a query returns. */
export async function ids(client: Client, sql: string, values?: unknown[]): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(sql, values);
  return rows.map((row) => row.id).sort();
}
