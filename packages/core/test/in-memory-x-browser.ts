import type {
  AuditEntry,
  NewRiskAcknowledgement,
  RiskAcknowledgement,
  XBrowserAdminStore,
  XBrowserFlags,
  XBrowserKillSignal,
  XBrowserOrganization,
  XBrowserScope,
  XBrowserStore,
  XBrowserUnitOfWork,
} from '../src';
import { ScopeViolation } from './in-memory-content';

// In-memory adapters for the X browser: the flags of the workspaces, organizations and the
// global kill switch, the acknowledgements, and a unit of work that hides other workspaces and
// rolls back on errors, like row-level security and a transaction.

interface Acknowledgement extends NewRiskAcknowledgement {
  revokedAt: Date | null;
}

interface State {
  global: { enabled: boolean; updatedAt: Date } | null;
  organizations: Map<string, { enabled: boolean; updatedAt: Date }>;
  workspaces: Map<string, boolean>;
  acknowledgements: Acknowledgement[];
  audit: AuditEntry[];
}

const emptyState = (): State => ({
  global: null,
  organizations: new Map(),
  workspaces: new Map(),
  acknowledgements: [],
  audit: [],
});

export class InMemoryXBrowser implements XBrowserUnitOfWork {
  state: State = emptyState();
  readonly names = new Map<string, string>();
  readonly directory = new Map<string, XBrowserOrganization>();
  /** The organization of each workspace slug. */
  readonly workspaceSlugs = new Map<string, XBrowserOrganization>();
  readonly runs: XBrowserScope[] = [];

  async run<T>(scope: XBrowserScope, work: (store: XBrowserStore) => Promise<T>): Promise<T> {
    this.runs.push(scope);
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  private storeFor(scope: XBrowserScope): XBrowserStore {
    const state = (): State => this.state;
    const assertScope = (workspaceId: string): void => {
      if (workspaceId !== scope.workspaceId) {
        throw new ScopeViolation(`workspace ${workspaceId} is outside the scope`);
      }
    };
    const view = (row: Acknowledgement): RiskAcknowledgement => ({
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      userName: this.names.get(row.userId) ?? null,
      textVersion: row.textVersion,
      textHash: row.textHash,
      locale: row.locale,
      acceptedAt: row.acceptedAt,
    });
    return {
      flags: (organizationId, workspaceId): Promise<XBrowserFlags> => {
        assertScope(workspaceId);
        return Promise.resolve({
          global: state().global?.enabled ?? null,
          organization: state().organizations.get(organizationId)?.enabled ?? null,
          workspace: state().workspaces.get(workspaceId) ?? null,
        });
      },
      setWorkspaceFlag: (_organizationId, workspaceId, enabled) => {
        assertScope(workspaceId);
        state().workspaces.set(workspaceId, enabled);
        return Promise.resolve();
      },
      acknowledgement: (workspaceId, subject) => {
        assertScope(workspaceId);
        const rows = state()
          .acknowledgements.filter(
            (row) => row.workspaceId === workspaceId && row.subject === subject && row.revokedAt === null,
          )
          .sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime());
        return Promise.resolve(rows[0] ? view(rows[0]) : null);
      },
      acknowledge: (acknowledgement) => {
        assertScope(acknowledgement.workspaceId);
        state().acknowledgements.push({ ...acknowledgement, revokedAt: null });
        return Promise.resolve();
      },
      revoke: (workspaceId, subject, at) => {
        assertScope(workspaceId);
        let revoked = 0;
        for (const row of state().acknowledgements) {
          if (row.workspaceId === workspaceId && row.subject === subject && row.revokedAt === null) {
            row.revokedAt = at;
            revoked += 1;
          }
        }
        return Promise.resolve(revoked);
      },
      audit: {
        record: (entry) => {
          state().audit.push(entry);
          return Promise.resolve();
        },
      },
    };
  }

  /** The admin store over the same state, as app_system sees it. */
  admin(now: () => Date): XBrowserAdminStore {
    return {
      globalFlag: () => Promise.resolve(this.state.global),
      setGlobalFlag: (enabled) => {
        this.state.global = { enabled, updatedAt: now() };
        return Promise.resolve();
      },
      allowedOrganizations: () =>
        Promise.resolve(
          [...this.state.organizations.entries()]
            .filter(([, flag]) => flag.enabled)
            .flatMap(([id, flag]) => {
              const organization = this.directory.get(id);
              return organization ? [{ ...organization, updatedAt: flag.updatedAt }] : [];
            }),
        ),
      organizationOfWorkspace: (workspaceSlug) =>
        Promise.resolve(this.workspaceSlugs.get(workspaceSlug) ?? null),
      setOrganizationFlag: (organizationId, allowed) => {
        if (!this.directory.has(organizationId)) {
          return Promise.resolve(false);
        }
        this.state.organizations.set(organizationId, { enabled: allowed, updatedAt: now() });
        return Promise.resolve(true);
      },
    };
  }
}

export class RecordingKillSignal implements XBrowserKillSignal {
  readonly signals: boolean[] = [];

  set(active: boolean): Promise<void> {
    this.signals.push(active);
    return Promise.resolve();
  }
}
