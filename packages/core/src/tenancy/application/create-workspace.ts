import { assertWithinLimit } from '../../billing/domain/limits';
import { NotPermittedError } from '../../shared/domain/errors';
import { isManager } from '../domain/roles';
import type { OrganizationActor, WorkspaceProfile } from '../domain/types';
import type { TenancyDependencies } from './dependencies';
import { createWorkspaceWithFreeSlug } from './workspace-slug';

export interface CreateWorkspaceInput {
  actor: OrganizationActor;
  profile: WorkspaceProfile;
}

/**
 * Adds a workspace with its settings to an organization. Owners and admins only, and only while
 * the plan has room for one more (guide step 7.4).
 */
export class CreateWorkspace {
  constructor(
    private readonly deps: Pick<TenancyDependencies, 'unitOfWork' | 'ids' | 'tokens' | 'entitlements'>,
  ) {}

  async execute(input: CreateWorkspaceInput): Promise<{ workspaceId: string; workspaceSlug: string }> {
    const { actor } = input;
    if (!isManager(actor.role)) {
      throw new NotPermittedError();
    }
    const { limits } = await this.deps.entitlements.of(actor.organizationId);
    const workspaceId = this.deps.ids.newId();
    const scope = { userId: actor.userId, organizationId: actor.organizationId, workspaceId };

    return this.deps.unitOfWork.run(scope, async (store) => {
      await store.organizations.lockPlan(actor.organizationId);
      assertWithinLimit(limits, 'maxWorkspaces', await store.workspaces.countIn(actor.organizationId));
      const workspaceSlug = await createWorkspaceWithFreeSlug(store, this.deps.tokens, {
        id: workspaceId,
        organizationId: actor.organizationId,
        ...input.profile,
      });
      await store.workspaces.createSettings(workspaceId);
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId,
        action: 'workspace.create',
        targetType: 'Workspace',
        targetId: workspaceId,
      });
      return { workspaceId, workspaceSlug };
    });
  }
}
