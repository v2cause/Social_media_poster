import { PresetStyleError, StyleNameTakenError, StyleNotFoundError } from '../domain/errors';
import { customStyleKey } from '../domain/rules';
import type { ContentActor } from '../domain/types';
import type { StylePatch } from '../ports/content-store';
import {
  assertCanManageBrand,
  assertUpdated,
  assertVersion,
  scopeOf,
  type ContentDependencies,
} from './dependencies';

// Custom styles of a workspace (guide steps 2.7 and 2.9). The prompt names a style by its key,
// derived from the name; the presets are the same for every workspace and cannot change.

export interface CreateStyleInput {
  actor: ContentActor;
  name: string;
  instructions: string;
}

export class CreateStyle {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork' | 'ids'>) {}

  async execute(input: CreateStyleInput): Promise<{ styleId: string }> {
    const { actor } = input;
    assertCanManageBrand(actor);
    return await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const key = customStyleKey(input.name);
      if (await store.styles.keyTaken(actor.workspaceId, key)) {
        throw new StyleNameTakenError();
      }
      const styleId = this.deps.ids.newId();
      await store.styles.insert({
        id: styleId,
        workspaceId: actor.workspaceId,
        key,
        name: input.name,
        instructions: input.instructions,
        isActive: true,
        sortOrder: await store.styles.nextSortOrder(actor.workspaceId),
        version: 0,
      });
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'style.create',
        targetType: 'PostStyle',
        targetId: styleId,
        metadata: { key },
      });
      return { styleId };
    });
  }
}

export interface UpdateStyleInput {
  actor: ContentActor;
  styleId: string;
  version: number;
  patch: Omit<StylePatch, 'key'>;
}

export class UpdateStyle {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork'>) {}

  async execute(input: UpdateStyleInput): Promise<void> {
    const { actor } = input;
    assertCanManageBrand(actor);
    await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const style = await store.styles.find(actor.workspaceId, input.styleId);
      if (!style) {
        throw new StyleNotFoundError();
      }
      if (style.workspaceId === null) {
        throw new PresetStyleError();
      }
      assertVersion(style.version, input.version);
      const patch: StylePatch = { ...input.patch };
      if (input.patch.name !== undefined) {
        patch.key = customStyleKey(input.patch.name);
        if (await store.styles.keyTaken(actor.workspaceId, patch.key, style.id)) {
          throw new StyleNameTakenError();
        }
      }
      assertUpdated(await store.styles.update(actor.workspaceId, style.id, input.version, patch));
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'style.update',
        targetType: 'PostStyle',
        targetId: style.id,
        metadata: { fields: Object.keys(input.patch).sort() },
      });
    });
  }
}
