import type { Platform } from '@smp/platform-rules';

import type { ContentLanguage } from '../../ai/domain/types';
import {
  BrandVoiceArchivedError,
  BrandVoiceNotFoundError,
  IdeaNotFoundError,
  PostLockedError,
  PostNotFoundError,
  StyleNotFoundError,
  VariantLockedError,
  VariantNotFoundError,
} from '../domain/errors';
import { isVariantEditable, isVariantInFlight, nextTargetKeys, statusAfterEdit } from '../domain/rules';
import type { ContentActor, PostVariant } from '../domain/types';
import type { ContentStore, PostPatch, VariantPatch } from '../ports/content-store';
import {
  assertCanWrite,
  assertUpdated,
  assertVersion,
  scopeOf,
  type ContentDependencies,
} from './dependencies';

// Posts and their variants (guide step 2.7). A post holds the brief and the choices of the
// composer; every target platform gets a variant with its own text. Updates use optimistic
// locking; the AI never writes into variants, the editor saves what the user takes over.

interface References {
  styleId?: string | null;
  brandVoiceId?: string | null;
  ideaId?: string | null;
}

/** The style, brand voice and idea must exist in the workspace; a voice must not be archived. */
async function assertReferences(store: ContentStore, workspaceId: string, refs: References): Promise<void> {
  if (refs.styleId && !(await store.styles.find(workspaceId, refs.styleId))) {
    throw new StyleNotFoundError();
  }
  if (refs.brandVoiceId) {
    const voice = await store.brandVoices.find(workspaceId, refs.brandVoiceId);
    if (!voice) {
      throw new BrandVoiceNotFoundError();
    }
    if (voice.archivedAt) {
      throw new BrandVoiceArchivedError();
    }
  }
  if (refs.ideaId && !(await store.ideas.find(workspaceId, refs.ideaId))) {
    throw new IdeaNotFoundError();
  }
}

function draftVariants(
  deps: Pick<ContentDependencies, 'ids'>,
  actor: ContentActor,
  postId: string,
  platforms: readonly Platform[],
  takenKeys: readonly string[],
): PostVariant[] {
  const keys = nextTargetKeys(takenKeys, platforms.length);
  return platforms.map((platform, index) => ({
    id: deps.ids.newId(),
    workspaceId: actor.workspaceId,
    postId,
    platform,
    targetKey: keys[index] ?? `t${String(takenKeys.length + index + 1)}`,
    text: '',
    hashtags: [],
    firstComment: null,
    linkUrl: null,
    aiWarnings: [],
    status: 'DRAFT',
    version: 0,
  }));
}

export interface CreatePostInput {
  actor: ContentActor;
  brief: string;
  language: ContentLanguage;
  styleId: string | null;
  brandVoiceId: string | null;
  ideaId: string | null;
  /** One draft variant per platform, in this order. */
  platforms: Platform[];
}

/** Creates a draft post with an empty variant per platform. A post from an idea uses it up. */
export class CreatePost {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork' | 'ids'>) {}

  async execute(input: CreatePostInput): Promise<{ postId: string }> {
    const { actor } = input;
    assertCanWrite(actor);
    return await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      await assertReferences(store, actor.workspaceId, input);
      const postId = this.deps.ids.newId();
      await store.posts.insert({
        id: postId,
        workspaceId: actor.workspaceId,
        brief: input.brief,
        language: input.language,
        styleId: input.styleId,
        brandVoiceId: input.brandVoiceId,
        ideaId: input.ideaId,
        createdById: actor.userId,
        version: 0,
      });
      await store.variants.insertMany(draftVariants(this.deps, actor, postId, input.platforms, []));
      if (input.ideaId) {
        await store.ideas.setStatus(actor.workspaceId, input.ideaId, 'USED');
      }
      return { postId };
    });
  }
}

export interface UpdatePostInput {
  actor: ContentActor;
  postId: string;
  version: number;
  patch: PostPatch;
  /** The new set of platforms: adds variants and removes the variants of dropped platforms. */
  platforms?: Platform[];
}

export class UpdatePost {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork' | 'ids'>) {}

  async execute(input: UpdatePostInput): Promise<void> {
    const { actor } = input;
    assertCanWrite(actor);
    await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const post = await store.posts.find(actor.workspaceId, input.postId);
      if (!post) {
        throw new PostNotFoundError();
      }
      const variants = await store.variants.ofPost(actor.workspaceId, post.id);
      if (variants.some((variant) => isVariantInFlight(variant.status))) {
        throw new PostLockedError();
      }
      assertVersion(post.version, input.version);
      await assertReferences(store, actor.workspaceId, input.patch);

      if (input.platforms) {
        const wanted = new Set(input.platforms);
        const dropped = variants.filter((variant) => !wanted.has(variant.platform));
        if (dropped.some((variant) => !isVariantEditable(variant.status))) {
          throw new VariantLockedError();
        }
        await store.variants.deleteMany(
          actor.workspaceId,
          dropped.map((variant) => variant.id),
        );
        const kept = variants.filter((variant) => wanted.has(variant.platform));
        const present = new Set(kept.map((variant) => variant.platform));
        const added = input.platforms.filter((platform) => !present.has(platform));
        await store.variants.insertMany(
          draftVariants(
            this.deps,
            actor,
            post.id,
            added,
            kept.map((variant) => variant.targetKey),
          ),
        );
      }

      const updated =
        Object.keys(input.patch).length > 0
          ? await store.posts.update(actor.workspaceId, post.id, input.version, input.patch)
          : await store.posts.touch(actor.workspaceId, post.id, input.version);
      assertUpdated(updated);
    });
  }
}

export interface DeletePostInput {
  actor: ContentActor;
  postId: string;
}

/** Deletes a post with its variants, unless one of them is being published. */
export class DeletePost {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork'>) {}

  async execute(input: DeletePostInput): Promise<void> {
    const { actor } = input;
    assertCanWrite(actor);
    await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const post = await store.posts.find(actor.workspaceId, input.postId);
      if (!post) {
        throw new PostNotFoundError();
      }
      const variants = await store.variants.ofPost(actor.workspaceId, post.id);
      if (variants.some((variant) => isVariantInFlight(variant.status))) {
        throw new PostLockedError();
      }
      await store.posts.delete(actor.workspaceId, post.id);
      await store.audit.record({
        organizationId: actor.organizationId,
        workspaceId: actor.workspaceId,
        action: 'post.delete',
        targetType: 'Post',
        targetId: post.id,
        metadata: { variants: variants.length },
      });
    });
  }
}

export interface UpdateVariantInput {
  actor: ContentActor;
  variantId: string;
  version: number;
  patch: VariantPatch;
}

/** Saves the editor's state of a variant. */
export class UpdateVariant {
  constructor(private readonly deps: Pick<ContentDependencies, 'unitOfWork'>) {}

  async execute(input: UpdateVariantInput): Promise<void> {
    const { actor } = input;
    assertCanWrite(actor);
    await this.deps.unitOfWork.run(scopeOf(actor), async (store) => {
      const variant = await store.variants.find(actor.workspaceId, input.variantId);
      if (!variant) {
        throw new VariantNotFoundError();
      }
      if (!isVariantEditable(variant.status)) {
        throw new VariantLockedError();
      }
      assertVersion(variant.version, input.version);
      const status = statusAfterEdit(variant.status);
      assertUpdated(
        await store.variants.update(actor.workspaceId, variant.id, input.version, {
          ...input.patch,
          ...(status === variant.status ? {} : { status }),
        }),
      );
    });
  }
}
