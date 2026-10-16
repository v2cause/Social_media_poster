import type { TenantContext } from './tenant-context';

// Defense in depth next to row-level security (architecture 6.3): in development and tests every
// query on a tenant table must filter by the tenant of the current context explicitly. A missing
// filter is a bug even when RLS hides the foreign rows. The tenant extension calls the check
// before every model operation when assertTenantFilter is enabled.

type Scope = 'organizationId' | 'workspaceId' | 'userId';

/** Tenant tables and the field that must carry the tenant of the context. */
export const TENANT_FILTERS: Readonly<Record<string, { field: string; scope: Scope }>> = {
  Organization: { field: 'id', scope: 'organizationId' },
  Workspace: { field: 'organizationId', scope: 'organizationId' },
  WorkspaceSettings: { field: 'workspaceId', scope: 'workspaceId' },
  Membership: { field: 'organizationId', scope: 'organizationId' },
  MembershipWorkspace: { field: 'organizationId', scope: 'organizationId' },
  Invitation: { field: 'organizationId', scope: 'organizationId' },
  AuditLog: { field: 'organizationId', scope: 'organizationId' },
  Notification: { field: 'userId', scope: 'userId' },
  NotificationPreference: { field: 'userId', scope: 'userId' },
};

const FILTERED_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);
const CREATE_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

export class TenantFilterMissingError extends Error {
  readonly code = 'tenant.filter_missing';

  constructor(model: string, operation: string, field: string) {
    super(`${model}.${operation} must filter by ${field} of the current tenant.`);
    this.name = 'TenantFilterMissingError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** True if the filter pins field to the expected id: directly, via equals, AND or a compound key. */
function pinsTenant(filter: unknown, field: string, expected: string): boolean {
  if (!isRecord(filter)) {
    return false;
  }
  const value = filter[field];
  if (typeof value === 'string') {
    return value === expected;
  }
  if (isRecord(value) && typeof value['equals'] === 'string') {
    return value['equals'] === expected;
  }
  const and = filter['AND'];
  if (Array.isArray(and) && and.some((part) => pinsTenant(part, field, expected))) {
    return true;
  }
  if (isRecord(and) && pinsTenant(and, field, expected)) {
    return true;
  }
  // Compound unique keys such as organizationId_userId.
  return Object.entries(filter).some(
    ([key, nested]) => key.includes('_') && isRecord(nested) && pinsTenant(nested, field, expected),
  );
}

/** Throws if a query on a tenant table does not pin the tenant of the context. */
export function assertTenantFilter(
  model: string,
  operation: string,
  args: unknown,
  context: TenantContext | undefined,
): void {
  const rule = TENANT_FILTERS[model];
  const expected = rule && context ? context[rule.scope] : undefined;
  // Without that tenant in the context, only the user-scoped read policies apply.
  if (!rule || expected === undefined || !isRecord(args)) {
    return;
  }
  const pinned = FILTERED_OPERATIONS.has(operation)
    ? pinsTenant(args['where'], rule.field, expected) &&
      (operation !== 'upsert' || pinsTenant(args['create'], rule.field, expected))
    : CREATE_OPERATIONS.has(operation)
      ? [args['data']].flat().every((row) => pinsTenant(row, rule.field, expected))
      : true;
  if (!pinned) {
    throw new TenantFilterMissingError(model, operation, rule.field);
  }
}
