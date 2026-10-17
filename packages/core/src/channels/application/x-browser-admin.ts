import { OrganizationNotFoundError, WorkspaceNotFoundError } from '../../tenancy/domain/errors';
import type { XBrowserAdminStore, XBrowserKillSignal, XBrowserOrganization } from '../ports/x-browser';

// The switches of the platform admins (guide step 6.1): the global kill switch and, until the
// plans of phase 7, the organizations that may use the X browser. The kill switch reaches the
// browser worker at once through its key in Redis; the flag in the database stays the source of
// truth. The circuit breaker (guide step 6.5) uses the same kill switch.

export interface XBrowserAdminDependencies {
  store: XBrowserAdminStore;
  killSignal: XBrowserKillSignal;
  /** FEATURE_X_BROWSER_GLOBAL. */
  offered: boolean;
}

export interface XBrowserAdminView {
  offered: boolean;
  killSwitch: { active: boolean; updatedAt: Date | null };
  organizations: (XBrowserOrganization & { updatedAt: Date })[];
}

export class GetXBrowserAdmin {
  constructor(private readonly deps: Pick<XBrowserAdminDependencies, 'store' | 'offered'>) {}

  async execute(): Promise<XBrowserAdminView> {
    const global = await this.deps.store.globalFlag();
    return {
      offered: this.deps.offered,
      killSwitch: { active: global?.enabled === false, updatedAt: global?.updatedAt ?? null },
      organizations: await this.deps.store.allowedOrganizations(),
    };
  }
}

export class SetXBrowserKillSwitch {
  constructor(private readonly deps: Pick<XBrowserAdminDependencies, 'store' | 'killSignal'>) {}

  /** Returns true when the switch changed. */
  async execute(active: boolean): Promise<boolean> {
    const before = await this.deps.store.globalFlag();
    await this.deps.store.setGlobalFlag(!active);
    await this.deps.killSignal.set(active);
    return (before?.enabled === false) !== active;
  }
}

export class SetXBrowserOrganization {
  constructor(private readonly deps: Pick<XBrowserAdminDependencies, 'store'>) {}

  /** Allows the organization of a workspace, named by the slug of the workspace. */
  async allow(workspaceSlug: string): Promise<XBrowserOrganization> {
    const organization = await this.deps.store.organizationOfWorkspace(workspaceSlug);
    if (!organization) {
      throw new WorkspaceNotFoundError();
    }
    await this.deps.store.setOrganizationFlag(organization.id, true);
    return organization;
  }

  async disallow(organizationId: string): Promise<void> {
    if (!(await this.deps.store.setOrganizationFlag(organizationId, false))) {
      throw new OrganizationNotFoundError();
    }
  }
}
