import { NotPermittedError } from '../../shared/domain/errors';
import { WorkspaceNotFoundError } from '../domain/errors';
import { isManager } from '../domain/roles';
import type { OrganizationActor, WorkspaceSettings } from '../domain/types';
import type { TenancyDependencies } from './dependencies';

export interface UpdateWorkspaceSettingsInput {
  actor: OrganizationActor & { workspaceId: string };
  patch: Partial<Omit<WorkspaceSettings, 'workspaceId'>>;
}

/** Changes dry run, the missed-window behavior or the AI effort overrides of a workspace. */
export class UpdateWorkspaceSettings {
  constructor(private readonly deps: Pick<TenancyDependencies, 'unitOfWork'>) {}

  async execute(input: UpdateWorkspaceSettingsInput): Promise<WorkspaceSettings> {
    const { actor } = input;
    if (!isManager(actor.role)) {
      throw new NotPermittedError();
    }
    const scope = {
      userId: actor.userId,
      organizationId: actor.organizationId,
      workspaceId: actor.workspaceId,
    };

    return this.deps.unitOfWork.run(scope, async (store) => {
      if (!(await store.workspaces.findById(actor.organizationId, actor.workspaceId))) {
        throw new WorkspaceNotFoundError();
      }
      const settings = await store.workspaces.updateSettings(actor.workspaceId, input.patch);
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'workspace.settings_update',
        targetType: 'WorkspaceSettings',
        targetId: actor.workspaceId,
        metadata: { fields: Object.keys(input.patch).sort() },
      });
      return settings;
    });
  }
}
