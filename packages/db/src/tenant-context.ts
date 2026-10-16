import type { Prisma, PrismaClient } from './generated/prisma/client';

/**
 * The tenant of the current request or job (architecture 6.3). Without organizationId only the
 * user-scoped read policies apply: own memberships, their organizations and workspaces, and
 * invitations to the user's address.
 */
export interface TenantContext {
  /** Missing only for the public invitation preview, which reads by token hash alone. */
  userId?: string;
  organizationId?: string;
  workspaceId?: string;
  /** Opens the one invitation with this hash (policy token_holder). */
  invitationTokenHash?: string;
}

/** Returns the context of the current request or job, for example from AsyncLocalStorage. */
export type TenantContextProvider = () => TenantContext | undefined;

export type TenantTransaction = Prisma.TransactionClient;

export class MissingTenantContextError extends Error {
  readonly code = 'TENANT_CONTEXT_MISSING';

  constructor(operation: string) {
    super(`No tenant context for ${operation}. Run it inside a request or job with a tenant.`);
    this.name = 'MissingTenantContextError';
  }
}

// Transaction-local (third argument true): the values disappear with the transaction and never
// stick to a pooled connection. An empty string stands for "not set"; the policies read it
// through NULLIF.
export const setTenantContext = (
  client: PrismaClient | TenantTransaction,
  context: TenantContext,
): Prisma.PrismaPromise<number> =>
  client.$executeRaw`SELECT set_config('app.user_id', ${context.userId ?? ''}, true),
                            set_config('app.organization_id', ${context.organizationId ?? ''}, true),
                            set_config('app.workspace_id', ${context.workspaceId ?? ''}, true),
                            set_config('app.invitation_token_hash', ${context.invitationTokenHash ?? ''}, true)`;

/**
 * Runs fn in one interactive transaction with the context set once at the start. Use it for
 * several statements that must be atomic. It runs on the base client: on the tenant client
 * every statement would become a batch transaction of its own, on another connection.
 */
export async function withTenantTx<T>(
  base: PrismaClient,
  context: TenantContext,
  fn: (tx: TenantTransaction) => Promise<T>,
): Promise<T> {
  return base.$transaction(async (tx) => {
    await setTenantContext(tx, context);
    return fn(tx);
  });
}
