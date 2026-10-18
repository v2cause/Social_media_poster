import { trialFrom } from '../../billing/domain/subscription';
import { EmailNotVerifiedError, OrganizationLimitReachedError } from '../domain/errors';
import type { WorkspaceProfile } from '../domain/types';
import type { TenancyDependencies } from './dependencies';
import { createWorkspaceWithFreeSlug } from './workspace-slug';

/**
 * Every new organization starts a trial with AI credit and storage. A user creates three in 30
 * days at most (guide step 8.4); more workspaces fit into one organization.
 */
export const NEW_ORGANIZATIONS_PER_USER = 3;
export const NEW_ORGANIZATIONS_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CreateOrganizationInput {
  user: { id: string; emailVerified: boolean };
  name: string;
  workspace: WorkspaceProfile;
}

export interface CreateOrganizationResult {
  organizationId: string;
  workspaceId: string;
  workspaceSlug: string;
}

/**
 * Creates organization, owner membership, first workspace and its settings in one transaction
 * (guide step 1.5), and starts the trial of the organization (guide step 7.1). Only users with a
 * verified email address may create organizations, and only a few in a period (guide step 8.4).
 */
export class CreateOrganization {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork' | 'ids' | 'tokens' | 'clock'>) {}

  async execute(input: CreateOrganizationInput): Promise<CreateOrganizationResult> {
    if (!input.user.emailVerified) {
      throw new EmailNotVerifiedError();
    }
    const { ids, tokens } = this.deps;
    const organizationId = ids.newId();
    const workspaceId = ids.newId();
    const scope = { userId: input.user.id, organizationId, workspaceId };

    return this.deps.unitOfWork.run(scope, async (store) => {
      await store.organizations.lockNewOrganizationsOf(input.user.id);
      const since = new Date(this.deps.clock.now().getTime() - NEW_ORGANIZATIONS_DAYS * DAY_MS);
      if ((await store.memberships.countOwnedSince(input.user.id, since)) >= NEW_ORGANIZATIONS_PER_USER) {
        throw new OrganizationLimitReachedError(NEW_ORGANIZATIONS_PER_USER, NEW_ORGANIZATIONS_DAYS);
      }
      await store.organizations.create({ id: organizationId, name: input.name });
      await store.trials.startTrial({ id: ids.newId(), organizationId, ...trialFrom(this.deps.clock.now()) });
      await store.memberships.create({
        id: ids.newId(),
        organizationId,
        userId: input.user.id,
        role: 'OWNER',
        workspaceIds: [],
      });
      const workspaceSlug = await createWorkspaceWithFreeSlug(store, tokens, {
        id: workspaceId,
        organizationId,
        ...input.workspace,
      });
      await store.workspaces.createSettings(workspaceId);
      await store.audit.record({
        organizationId,
        action: 'organization.create',
        targetType: 'Organization',
        targetId: organizationId,
      });
      await store.audit.record({
        organizationId,
        workspaceId,
        action: 'workspace.create',
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      return { organizationId, workspaceId, workspaceSlug };
    });
  }
}
