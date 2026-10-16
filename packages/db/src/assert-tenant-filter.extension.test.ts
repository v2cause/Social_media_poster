import { describe, expect, it } from 'vitest';

import { assertTenantFilter, TenantFilterMissingError } from './assert-tenant-filter.extension';
import type { TenantContext } from './tenant-context';

const ORG = '0199f000-0000-7000-8000-000000000001';
const OTHER_ORG = '0199f000-0000-7000-8000-000000000002';
const WS = '0199f000-0000-7000-8000-000000000003';
const USER = '0199f000-0000-7000-8000-000000000004';
const context = { userId: USER, organizationId: ORG, workspaceId: WS };

// Wraps the check in a thunk for toThrow.
const check =
  (model: string, operation: string, args: unknown, tenant: TenantContext = context) =>
  (): void => {
    assertTenantFilter(model, operation, args, tenant);
  };

describe('assertTenantFilter', () => {
  it('accepts a query that pins the tenant of the context', () => {
    expect(check('Membership', 'findMany', { where: { organizationId: ORG } })).not.toThrow();
    expect(
      check('Workspace', 'findFirst', {
        where: { AND: [{ slug: 'x' }, { organizationId: { equals: ORG } }] },
      }),
    ).not.toThrow();
    expect(
      check('Membership', 'findUnique', {
        where: { organizationId_userId: { organizationId: ORG, userId: USER } },
      }),
    ).not.toThrow();
    expect(check('WorkspaceSettings', 'update', { where: { workspaceId: WS }, data: {} })).not.toThrow();
  });

  it('rejects a query without the tenant filter', () => {
    expect(check('Membership', 'findMany', { where: { userId: USER } })).toThrow(TenantFilterMissingError);
    expect(check('Invitation', 'deleteMany', {})).toThrow(TenantFilterMissingError);
  });

  it('rejects a filter on another tenant or on several tenants', () => {
    expect(check('Workspace', 'findMany', { where: { organizationId: OTHER_ORG } })).toThrow(
      TenantFilterMissingError,
    );
    expect(check('Workspace', 'findMany', { where: { organizationId: { in: [ORG, OTHER_ORG] } } })).toThrow(
      TenantFilterMissingError,
    );
  });

  it('checks the data of creates and both parts of an upsert', () => {
    expect(check('AuditLog', 'create', { data: { organizationId: ORG, action: 'x' } })).not.toThrow();
    expect(
      check('AuditLog', 'createMany', { data: [{ organizationId: ORG }, { organizationId: OTHER_ORG }] }),
    ).toThrow(TenantFilterMissingError);
    expect(
      check('Membership', 'upsert', {
        where: { organizationId_userId: { organizationId: ORG, userId: USER } },
        create: { organizationId: OTHER_ORG, userId: USER },
        update: {},
      }),
    ).toThrow(TenantFilterMissingError);
  });

  it('skips the check without that tenant in the context and for tables without tenant', () => {
    expect(check('Membership', 'findMany', { where: { userId: USER } }, { userId: USER })).not.toThrow();
    expect(check('User', 'findMany', {})).not.toThrow();
  });
});
