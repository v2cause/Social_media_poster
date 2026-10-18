import type {
  AuditEntry,
  Clock,
  Entitlements,
  IdGenerator,
  Invitation,
  InvitationMessage,
  InvitationNotifier,
  Membership,
  Organization,
  PlanEntitlements,
  PlanLimits,
  SecretTokens,
  TenancyDependencies,
  TenancyScope,
  TenancyStore,
  TenancyUnitOfWork,
  Workspace,
  WorkspaceProfile,
  WorkspaceSettings,
} from '../src';
import { planOf } from './in-memory-billing';

// An in-memory unit of work for the use case tests. Like row-level security, it hides rows of
// other organizations and rejects writes outside the scope, and it rolls back on errors.

interface State {
  organizations: Map<string, Organization>;
  workspaces: Map<string, Workspace>;
  settings: Map<string, WorkspaceSettings>;
  memberships: Map<string, Membership>;
  invitations: Map<string, Invitation>;
  audit: (AuditEntry & { scopeUserId: string })[];
  trials: Map<string, { id: string; trialEndsAt: Date; readOnlyAt: Date }>;
  /** The organizations that require a second factor of every member. */
  twoFactorRequired: Set<string>;
  /** When each membership was created; seeded ones are old. */
  membershipCreatedAt: Map<string, Date>;
}

const emptyState = (): State => ({
  organizations: new Map(),
  workspaces: new Map(),
  settings: new Map(),
  memberships: new Map(),
  invitations: new Map(),
  audit: [],
  trials: new Map(),
  twoFactorRequired: new Set(),
  membershipCreatedAt: new Map(),
});

export class ScopeViolation extends Error {}

export class InMemoryTenancy implements TenancyUnitOfWork {
  state: State = emptyState();
  /** Slugs that exist in organizations the tests do not model. */
  readonly foreignSlugs = new Set<string>();
  readonly users = new Map<string, string>();
  readonly scopes: TenancyScope[] = [];
  /** The organizations whose plan lock a transaction took. */
  readonly planLocks: string[] = [];
  /** The users whose lock on new organizations a transaction took. */
  readonly newOrganizationLocks: string[] = [];

  constructor(private readonly clock: Clock = new FixedClock()) {}

  async run<T>(scope: TenancyScope, work: (store: TenancyStore) => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    const snapshot = structuredClone(this.state);
    try {
      return await work(this.storeFor(scope));
    } catch (error) {
      this.state = snapshot;
      throw error;
    }
  }

  // --- test setup helpers ---------------------------------------------------------------------

  addUser(id: string, email: string): void {
    this.users.set(id, email);
  }

  seed(data: {
    organization: Organization;
    workspaces?: Workspace[];
    memberships?: Membership[];
    invitations?: Invitation[];
  }): void {
    this.state.organizations.set(data.organization.id, data.organization);
    for (const workspace of data.workspaces ?? []) {
      this.state.workspaces.set(workspace.id, workspace);
      this.state.settings.set(workspace.id, {
        workspaceId: workspace.id,
        dryRun: false,
        missedWindowBehavior: 'FAIL',
        effortOverrides: null,
      });
    }
    for (const membership of data.memberships ?? []) {
      this.state.memberships.set(membership.id, membership);
    }
    for (const invitation of data.invitations ?? []) {
      this.state.invitations.set(invitation.id, invitation);
    }
  }

  membershipsOf(organizationId: string): Membership[] {
    return [...this.state.memberships.values()].filter((m) => m.organizationId === organizationId);
  }

  // --- the store ------------------------------------------------------------------------------

  private storeFor(scope: TenancyScope): TenancyStore {
    const inOrg = (organizationId: string) => scope.organizationId === organizationId;
    const writeOrg = (organizationId: string) => {
      if (!inOrg(organizationId)) {
        throw new ScopeViolation(`write to organization ${organizationId} outside the scope`);
      }
    };
    const writeWorkspace = (workspaceId: string) => {
      if (scope.workspaceId !== workspaceId) {
        throw new ScopeViolation(`write to workspace ${workspaceId} outside the scope`);
      }
    };
    const state = () => this.state;
    const findMembership = (predicate: (m: Membership) => boolean) =>
      [...state().memberships.values()].find((m) => inOrg(m.organizationId) && predicate(m)) ?? null;
    const findInvitation = (predicate: (i: Invitation) => boolean) =>
      [...state().invitations.values()].find(predicate) ?? null;

    return {
      organizations: {
        create: (organization) => {
          writeOrg(organization.id);
          state().organizations.set(organization.id, organization);
          return Promise.resolve();
        },
        findById: (organizationId) =>
          Promise.resolve(inOrg(organizationId) ? (state().organizations.get(organizationId) ?? null) : null),
        lockPlan: (organizationId) => {
          writeOrg(organizationId);
          this.planLocks.push(organizationId);
          return Promise.resolve();
        },
        lockNewOrganizationsOf: (userId) => {
          this.newOrganizationLocks.push(userId);
          return Promise.resolve();
        },
        setTwoFactorRequired: (organizationId, required) => {
          writeOrg(organizationId);
          if (required) {
            state().twoFactorRequired.add(organizationId);
          } else {
            state().twoFactorRequired.delete(organizationId);
          }
          return Promise.resolve();
        },
      },
      workspaces: {
        create: (workspace) => {
          writeOrg(workspace.organizationId);
          const taken =
            this.foreignSlugs.has(workspace.slug) ||
            [...state().workspaces.values()].some((w) => w.slug === workspace.slug);
          if (!taken) {
            state().workspaces.set(workspace.id, workspace);
          }
          return Promise.resolve(!taken);
        },
        findById: (organizationId, workspaceId) => {
          const workspace = state().workspaces.get(workspaceId);
          return Promise.resolve(
            workspace && inOrg(organizationId) && workspace.organizationId === organizationId
              ? workspace
              : null,
          );
        },
        allBelongTo: (organizationId, workspaceIds) =>
          Promise.resolve(
            inOrg(organizationId) &&
              workspaceIds.every((id) => state().workspaces.get(id)?.organizationId === organizationId),
          ),
        countIn: (organizationId) =>
          Promise.resolve(
            inOrg(organizationId)
              ? [...state().workspaces.values()].filter((w) => w.organizationId === organizationId).length
              : 0,
          ),
        createSettings: (workspaceId) => {
          writeWorkspace(workspaceId);
          state().settings.set(workspaceId, {
            workspaceId,
            dryRun: false,
            missedWindowBehavior: 'FAIL',
            effortOverrides: null,
          });
          return Promise.resolve();
        },
        findSettings: (workspaceId) =>
          Promise.resolve(
            scope.workspaceId === workspaceId ? (state().settings.get(workspaceId) ?? null) : null,
          ),
        updateSettings: (workspaceId, patch) => {
          writeWorkspace(workspaceId);
          const current = state().settings.get(workspaceId);
          if (!current) {
            throw new Error('settings missing');
          }
          const next = { ...current, ...patch };
          state().settings.set(workspaceId, next);
          return Promise.resolve(next);
        },
      },
      memberships: {
        create: (membership) => {
          writeOrg(membership.organizationId);
          const duplicate = [...state().memberships.values()].some(
            (m) => m.organizationId === membership.organizationId && m.userId === membership.userId,
          );
          if (duplicate) {
            throw new Error('unique violation: membership(organization_id, user_id)');
          }
          state().memberships.set(membership.id, membership);
          state().membershipCreatedAt.set(membership.id, this.clock.now());
          return Promise.resolve();
        },
        findById: (organizationId, membershipId) =>
          Promise.resolve(
            findMembership((m) => m.organizationId === organizationId && m.id === membershipId),
          ),
        findByUser: (organizationId, userId) =>
          Promise.resolve(findMembership((m) => m.organizationId === organizationId && m.userId === userId)),
        findByEmail: (organizationId, email) =>
          Promise.resolve(
            findMembership(
              (m) => m.organizationId === organizationId && this.users.get(m.userId)?.toLowerCase() === email,
            ),
          ),
        countIn: (organizationId) =>
          Promise.resolve(
            [...state().memberships.values()].filter(
              (m) => inOrg(organizationId) && m.organizationId === organizationId,
            ).length,
          ),
        countOwnersForUpdate: (organizationId) =>
          Promise.resolve(
            [...state().memberships.values()].filter(
              (m) => inOrg(organizationId) && m.organizationId === organizationId && m.role === 'OWNER',
            ).length,
          ),
        // Like the policy own_memberships: the user's memberships in every organization.
        countOwnedSince: (userId, since) =>
          Promise.resolve(
            [...state().memberships.values()].filter(
              (m) =>
                m.userId === userId &&
                m.role === 'OWNER' &&
                (state().membershipCreatedAt.get(m.id) ?? new Date(0)) >= since,
            ).length,
          ),
        updateRole: (organizationId, membershipId, role) => {
          writeOrg(organizationId);
          const membership = state().memberships.get(membershipId);
          if (membership?.organizationId === organizationId) {
            state().memberships.set(membershipId, { ...membership, role });
          }
          return Promise.resolve();
        },
        delete: (organizationId, membershipId) => {
          writeOrg(organizationId);
          if (state().memberships.get(membershipId)?.organizationId === organizationId) {
            state().memberships.delete(membershipId);
          }
          return Promise.resolve();
        },
      },
      invitations: {
        create: (invitation) => {
          writeOrg(invitation.organizationId);
          state().invitations.set(invitation.id, invitation);
          return Promise.resolve();
        },
        findById: (organizationId, invitationId) =>
          Promise.resolve(
            findInvitation(
              (i) => inOrg(organizationId) && i.organizationId === organizationId && i.id === invitationId,
            ),
          ),
        findByTokenHash: (tokenHash) =>
          Promise.resolve(
            findInvitation(
              (i) =>
                i.tokenHash === tokenHash &&
                (scope.invitationTokenHash === tokenHash || inOrg(i.organizationId)),
            ),
          ),
        revokeOpen: (organizationId, email, at) => {
          writeOrg(organizationId);
          let count = 0;
          for (const invitation of state().invitations.values()) {
            if (
              invitation.organizationId === organizationId &&
              invitation.email === email &&
              invitation.acceptedAt === null &&
              invitation.revokedAt === null
            ) {
              state().invitations.set(invitation.id, { ...invitation, revokedAt: at });
              count += 1;
            }
          }
          return Promise.resolve(count);
        },
        countOpen: (organizationId, at, exceptEmail) =>
          Promise.resolve(
            [...state().invitations.values()].filter(
              (i) =>
                inOrg(organizationId) &&
                i.organizationId === organizationId &&
                i.email !== exceptEmail &&
                i.acceptedAt === null &&
                i.revokedAt === null &&
                i.expiresAt > at,
            ).length,
          ),
        markAccepted: (organizationId, invitationId, at) => {
          writeOrg(organizationId);
          const invitation = state().invitations.get(invitationId);
          const open =
            invitation?.organizationId === organizationId &&
            invitation.acceptedAt === null &&
            invitation.revokedAt === null &&
            invitation.expiresAt > at;
          if (invitation && open) {
            state().invitations.set(invitationId, { ...invitation, acceptedAt: at });
          }
          return Promise.resolve(open);
        },
        revoke: (organizationId, invitationId, at) => {
          writeOrg(organizationId);
          const invitation = state().invitations.get(invitationId);
          const open =
            invitation?.organizationId === organizationId &&
            invitation.acceptedAt === null &&
            invitation.revokedAt === null;
          if (invitation && open) {
            state().invitations.set(invitationId, { ...invitation, revokedAt: at });
          }
          return Promise.resolve(open);
        },
        renew: (organizationId, invitationId, tokenHash, expiresAt) => {
          writeOrg(organizationId);
          const invitation = state().invitations.get(invitationId);
          if (invitation?.organizationId === organizationId) {
            state().invitations.set(invitationId, { ...invitation, tokenHash, expiresAt });
          }
          return Promise.resolve();
        },
      },
      audit: {
        record: (entry) => {
          writeOrg(entry.organizationId);
          state().audit.push({ ...entry, scopeUserId: scope.userId });
          return Promise.resolve();
        },
      },
      trials: {
        startTrial: ({ organizationId, ...trial }) => {
          writeOrg(organizationId);
          state().trials.set(organizationId, trial);
          return Promise.resolve();
        },
      },
    };
  }
}

export class FixedClock implements Clock {
  constructor(public current = new Date('2026-10-16T09:00:00.000Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class SequentialIds implements IdGenerator {
  private next = 0;
  newId(): string {
    this.next += 1;
    return `00000000-0000-7000-8000-${String(this.next).padStart(12, '0')}`;
  }
}

export class FakeTokens implements SecretTokens {
  private next = 0;
  private suffix = 0;
  create(): { token: string; hash: string } {
    this.next += 1;
    const token = `token-${String(this.next)}`;
    return { token, hash: this.hash(token) };
  }
  hash(token: string): string {
    return `sha256(${token})`;
  }
  slugSuffix(): string {
    this.suffix += 1;
    return `s${String(this.suffix)}`;
  }
}

export class RecordingNotifier implements InvitationNotifier {
  readonly sent: InvitationMessage[] = [];
  invitationCreated(message: InvitationMessage): Promise<void> {
    this.sent.push(message);
    return Promise.resolve();
  }
}

/** The entitlements of every organization: the agency plan unless a test lowers a limit. */
export class FixedEntitlements implements PlanEntitlements {
  limits: PlanLimits = { ...planOf('agency').limits };

  of(organizationId: string): Promise<Entitlements> {
    return Promise.resolve({
      organizationId,
      plan: planOf('agency'),
      limits: this.limits,
      status: 'ACTIVE',
      readOnly: false,
      readOnlyAt: null,
      trialEndsAt: null,
      graceEndsAt: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
  }
}

export interface TenancyTestbed extends TenancyDependencies {
  unitOfWork: InMemoryTenancy;
  clock: FixedClock;
  notifier: RecordingNotifier;
  entitlements: FixedEntitlements;
}

export const createTestbed = (): TenancyTestbed => {
  const clock = new FixedClock();
  return {
    unitOfWork: new InMemoryTenancy(clock),
    clock,
    ids: new SequentialIds(),
    tokens: new FakeTokens(),
    notifier: new RecordingNotifier(),
    entitlements: new FixedEntitlements(),
  };
};

export const PROFILE: WorkspaceProfile = {
  name: 'Marketing & Sales',
  timezone: 'Europe/Berlin',
  contentLanguage: 'de',
  industry: 'Software',
  targetAudience: null,
  goals: null,
  contentPillars: ['Produkt'],
};

/** An organization with one workspace and members with the given roles. */
export function seedOrganization(
  testbed: TenancyTestbed,
  members: { userId: string; email: string; role: Membership['role']; workspaceIds?: string[] }[],
) {
  const organizationId = 'org-1';
  const workspace: Workspace = { id: 'ws-1', organizationId, slug: 'marketing', ...PROFILE };
  const memberships = members.map((member, index) => {
    testbed.unitOfWork.addUser(member.userId, member.email);
    return {
      id: `membership-${String(index + 1)}`,
      organizationId,
      userId: member.userId,
      role: member.role,
      workspaceIds: member.workspaceIds ?? [],
    };
  });
  testbed.unitOfWork.seed({
    organization: { id: organizationId, name: 'Acme' },
    workspaces: [workspace],
    memberships,
  });
  return { organizationId, workspace, memberships };
}
