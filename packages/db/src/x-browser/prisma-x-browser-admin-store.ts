import { X_BROWSER_FLAG, type XBrowserAdminStore, type XBrowserOrganization } from '@smp/core';

import { runInSystemScope, type SystemPrismaClient } from '../system-client';
import { lockFlag, setFlag } from './feature-flags';

const GLOBAL = { organizationId: null, workspaceId: null } as const;

// The switches of the platform admins and of the circuit breaker (guide steps 6.1 and 6.5): the
// global row of the flag is the kill switch, a row of an organization its gate until the plans
// of phase 7. Both belong to no workspace, so they are written as app_system.

interface OrganizationRow {
  id: string;
  name: string;
  updated_at: Date;
}

export class PrismaXBrowserAdminStore implements XBrowserAdminStore {
  constructor(private readonly system: SystemPrismaClient) {}

  async globalFlag(): Promise<{ enabled: boolean; updatedAt: Date } | null> {
    const row = await runInSystemScope(() =>
      this.system.featureFlag.findFirst({
        where: { key: X_BROWSER_FLAG, organizationId: null, workspaceId: null },
        orderBy: { updatedAt: 'desc' },
      }),
    );
    return row ? { enabled: row.enabled, updatedAt: row.updatedAt } : null;
  }

  async setGlobalFlag(enabled: boolean): Promise<void> {
    await runInSystemScope(() =>
      this.system.$transaction((tx) => setFlag(tx, X_BROWSER_FLAG, GLOBAL, enabled)),
    );
  }

  async closeGlobalFlag(): Promise<boolean> {
    return runInSystemScope(() =>
      this.system.$transaction(async (tx) => {
        // Under the lock of the flag a second breaker sees what the first one wrote.
        await lockFlag(tx, X_BROWSER_FLAG, GLOBAL);
        const row = await tx.featureFlag.findFirst({
          where: { key: X_BROWSER_FLAG, ...GLOBAL },
          select: { enabled: true },
        });
        if (row?.enabled === false) {
          return false;
        }
        await setFlag(tx, X_BROWSER_FLAG, GLOBAL, false);
        return true;
      }),
    );
  }

  async allowedOrganizations(): Promise<(XBrowserOrganization & { updatedAt: Date })[]> {
    const rows = await runInSystemScope(
      () => this.system.$queryRaw<OrganizationRow[]>`
        SELECT o.id, o.name, f.updated_at
          FROM feature_flag f
          JOIN organization o ON o.id = f.organization_id
         WHERE f.key = ${X_BROWSER_FLAG}
           AND f.workspace_id IS NULL
           AND f.enabled
         ORDER BY o.name, o.id`,
    );
    return rows.map((row) => ({ id: row.id, name: row.name, updatedAt: row.updated_at }));
  }

  async organizationOfWorkspace(workspaceSlug: string): Promise<XBrowserOrganization | null> {
    const workspace = await runInSystemScope(() =>
      this.system.workspace.findUnique({
        where: { slug: workspaceSlug },
        select: { organization: { select: { id: true, name: true } } },
      }),
    );
    return workspace ? { id: workspace.organization.id, name: workspace.organization.name } : null;
  }

  async setOrganizationFlag(organizationId: string, allowed: boolean): Promise<boolean> {
    return runInSystemScope(() =>
      this.system.$transaction(async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true },
        });
        if (!organization) {
          return false;
        }
        await setFlag(tx, X_BROWSER_FLAG, { organizationId, workspaceId: null }, allowed);
        return true;
      }),
    );
  }
}
