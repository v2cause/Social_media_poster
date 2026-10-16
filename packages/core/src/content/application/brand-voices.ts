import type { BrandVoiceContent } from '../../ai/domain/types';
import { BrandVoiceNotFoundError } from '../domain/errors';
import { canonicalJson } from '../domain/rules';
import type { ContentActor } from '../domain/types';
import type { BrandVoicePatch } from '../ports/content-store';
import {
  assertCanManageBrand,
  assertUpdated,
  assertVersion,
  scopeOf,
  type ContentDependencies,
} from './dependencies';

// Brand voices (guide steps 2.7 and 2.9). The content lives in immutable versions: every change
// of the content adds a version, and every AI generation names the version it used. One voice per
// workspace can be the default the composer preselects.

export interface CreateBrandVoiceInput {
  actor: ContentActor;
  content: BrandVoiceContent;
  isDefault: boolean;
}

export class CreateBrandVoice {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork' | 'ids'>) {}

  async execute(input: CreateBrandVoiceInput): Promise<{ brandVoiceId: string }> {
    const { actor } = input;
    assertCanManageBrand(actor);
    return await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const brandVoiceId = this.deps.ids.newId();
      // The first voice of a workspace becomes its default.
      const isDefault = input.isDefault || !(await store.brandVoices.findDefault(actor.workspaceId));
      await store.brandVoices.insert(
        {
          id: brandVoiceId,
          workspaceId: actor.workspaceId,
          name: input.content.name,
          currentVersionNumber: 1,
          isDefault,
          archivedAt: null,
          version: 0,
        },
        {
          id: this.deps.ids.newId(),
          workspaceId: actor.workspaceId,
          brandVoiceId,
          versionNumber: 1,
          content: input.content,
          createdById: actor.userId,
        },
      );
      if (isDefault) {
        await store.brandVoices.clearDefault(actor.workspaceId, brandVoiceId);
      }
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'brand_voice.create',
        targetType: 'BrandVoice',
        targetId: brandVoiceId,
        metadata: { isDefault },
      });
      return { brandVoiceId };
    });
  }
}

export interface UpdateBrandVoiceInput {
  actor: ContentActor;
  brandVoiceId: string;
  version: number;
  content?: BrandVoiceContent;
  isDefault?: boolean;
  archived?: boolean;
}

export class UpdateBrandVoice {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork' | 'ids' | 'clock'>) {}

  async execute(input: UpdateBrandVoiceInput): Promise<void> {
    const { actor } = input;
    assertCanManageBrand(actor);
    await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const voice = await store.brandVoices.find(actor.workspaceId, input.brandVoiceId);
      if (!voice) {
        throw new BrandVoiceNotFoundError();
      }
      assertVersion(voice.version, input.version);
      const patch: BrandVoicePatch = {};

      if (input.content) {
        const current = await store.brandVoices.findVersion(
          actor.workspaceId,
          voice.id,
          voice.currentVersionNumber,
        );
        // Saving unchanged content adds no version.
        if (!current || canonicalJson(current.content) !== canonicalJson(input.content)) {
          const versionNumber = voice.currentVersionNumber + 1;
          await store.brandVoices.addVersion({
            id: this.deps.ids.newId(),
            workspaceId: actor.workspaceId,
            brandVoiceId: voice.id,
            versionNumber,
            content: input.content,
            createdById: actor.userId,
          });
          patch.currentVersionNumber = versionNumber;
          patch.name = input.content.name;
        }
      }
      if (input.archived !== undefined) {
        patch.archivedAt = input.archived ? (voice.archivedAt ?? this.deps.clock.now()) : null;
      }
      // An archived voice cannot stay the default.
      const isDefault = input.archived === true ? false : input.isDefault;
      if (isDefault !== undefined) {
        patch.isDefault = isDefault;
      }

      assertUpdated(await store.brandVoices.update(actor.workspaceId, voice.id, input.version, patch));
      if (patch.isDefault === true) {
        await store.brandVoices.clearDefault(actor.workspaceId, voice.id);
      }
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'brand_voice.update',
        targetType: 'BrandVoice',
        targetId: voice.id,
        metadata: {
          fields: Object.keys(patch).sort(),
          versionNumber: patch.currentVersionNumber ?? voice.currentVersionNumber,
        },
      });
    });
  }
}
