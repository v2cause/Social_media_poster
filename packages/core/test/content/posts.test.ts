import { describe, expect, it } from 'vitest';

import {
  BrandVoiceArchivedError,
  CreatePost,
  DeletePost,
  NotPermittedError,
  PostLockedError,
  PostNotFoundError,
  StyleNotFoundError,
  UpdatePost,
  UpdateVariant,
  VariantLockedError,
  VersionConflictError,
  type PostVariant,
} from '../../src';
import { actorOf, createContentTestbed, PRESET_STYLE, ScopeViolation } from '../in-memory-content';

const editor = actorOf('EDITOR');

async function createPost(testbed = createContentTestbed()) {
  const { postId } = await new CreatePost(testbed).execute({
    actor: editor,
    brief: 'Neues Büro in Köln',
    language: 'de',
    styleId: PRESET_STYLE.id,
    brandVoiceId: null,
    ideaId: null,
    platforms: ['LINKEDIN', 'X'],
  });
  return { testbed, postId };
}

const variantsOf = (testbed: ReturnType<typeof createContentTestbed>, postId: string) =>
  [...testbed.unitOfWork.state.variants.values()]
    .filter((variant) => variant.postId === postId)
    .sort((a, b) => a.targetKey.localeCompare(b.targetKey));

describe('CreatePost', () => {
  it('creates a draft with one empty variant per platform as targets t1, t2', async () => {
    const { testbed, postId } = await createPost();

    expect(testbed.unitOfWork.state.posts.get(postId)).toMatchObject({
      workspaceId: 'ws-1',
      brief: 'Neues Büro in Köln',
      styleId: PRESET_STYLE.id,
      createdById: editor.userId,
      version: 0,
    });
    expect(
      variantsOf(testbed, postId).map((variant) => [variant.targetKey, variant.platform, variant.status]),
    ).toEqual([
      ['t1', 'LINKEDIN', 'DRAFT'],
      ['t2', 'X', 'DRAFT'],
    ]);
    expect(testbed.unitOfWork.scopes).toEqual([
      { userId: editor.userId, organizationId: 'org-1', workspaceId: 'ws-1' },
    ]);
  });

  it('refuses viewers and unknown or archived references', async () => {
    const testbed = createContentTestbed();
    const create = new CreatePost(testbed);
    const input = {
      brief: '',
      language: 'de' as const,
      styleId: null,
      brandVoiceId: null,
      ideaId: null,
      platforms: ['LINKEDIN' as const],
    };
    testbed.unitOfWork.state.voices.set('voice-archived', {
      id: 'voice-archived',
      workspaceId: 'ws-1',
      name: 'Old',
      currentVersionNumber: 1,
      isDefault: false,
      archivedAt: new Date('2026-01-01T00:00:00Z'),
      version: 0,
    });

    await expect(create.execute({ ...input, actor: actorOf('VIEWER') })).rejects.toBeInstanceOf(
      NotPermittedError,
    );
    await expect(
      create.execute({ ...input, actor: editor, styleId: 'style-unknown' }),
    ).rejects.toBeInstanceOf(StyleNotFoundError);
    await expect(
      create.execute({ ...input, actor: editor, brandVoiceId: 'voice-archived' }),
    ).rejects.toBeInstanceOf(BrandVoiceArchivedError);
    expect(testbed.unitOfWork.state.posts.size).toBe(0);
  });

  it('uses up the idea it was created from', async () => {
    const testbed = createContentTestbed();
    testbed.unitOfWork.state.ideas.set('idea-1', {
      id: 'idea-1',
      workspaceId: 'ws-1',
      title: 'Hinter den Kulissen',
      angle: null,
      pillar: null,
      whyNow: null,
      basedOn: [],
      suggestedPlatforms: [],
      suggestedStyleKey: null,
      format: null,
      status: 'SAVED',
      source: 'AI',
      aiGenerationId: null,
      createdById: null,
      version: 0,
    });

    await new CreatePost(testbed).execute({
      actor: editor,
      brief: '',
      language: 'de',
      styleId: null,
      brandVoiceId: null,
      ideaId: 'idea-1',
      platforms: ['INSTAGRAM'],
    });

    expect(testbed.unitOfWork.state.ideas.get('idea-1')?.status).toBe('USED');
  });
});

describe('UpdatePost', () => {
  it('changes the brief with the current version and refuses a stale one', async () => {
    const { testbed, postId } = await createPost();
    const update = new UpdatePost(testbed);

    await update.execute({ actor: editor, postId, version: 0, patch: { brief: 'Neu' } });
    await expect(
      update.execute({ actor: editor, postId, version: 0, patch: { brief: 'Alt' } }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    expect(testbed.unitOfWork.state.posts.get(postId)).toMatchObject({ brief: 'Neu', version: 1 });
  });

  it('adds variants for new platforms and removes the drafts of dropped ones', async () => {
    const { testbed, postId } = await createPost();

    await new UpdatePost(testbed).execute({
      actor: editor,
      postId,
      version: 0,
      patch: {},
      platforms: ['X', 'INSTAGRAM', 'FACEBOOK'],
    });

    expect(variantsOf(testbed, postId).map((variant) => [variant.targetKey, variant.platform])).toEqual([
      ['t1', 'INSTAGRAM'],
      ['t2', 'X'],
      ['t3', 'FACEBOOK'],
    ]);
    expect(testbed.unitOfWork.state.posts.get(postId)?.version).toBe(1);
  });

  it('keeps variants that are being published and the post they belong to', async () => {
    const { testbed, postId } = await createPost();
    const [linkedin] = variantsOf(testbed, postId);
    if (!linkedin) {
      throw new Error('missing variant');
    }
    testbed.unitOfWork.state.variants.set(linkedin.id, { ...linkedin, status: 'PUBLISHING' });

    await expect(
      new UpdatePost(testbed).execute({ actor: editor, postId, version: 0, patch: { brief: 'x' } }),
    ).rejects.toBeInstanceOf(PostLockedError);
    await expect(new DeletePost(testbed).execute({ actor: editor, postId })).rejects.toBeInstanceOf(
      PostLockedError,
    );
  });
});

describe('DeletePost', () => {
  it('deletes the post with its variants and records it', async () => {
    const { testbed, postId } = await createPost();

    await new DeletePost(testbed).execute({ actor: editor, postId });

    expect(testbed.unitOfWork.state.posts.size).toBe(0);
    expect(testbed.unitOfWork.state.variants.size).toBe(0);
    expect(testbed.unitOfWork.state.audit).toEqual([
      expect.objectContaining({ action: 'post.delete', targetId: postId, metadata: { variants: 2 } }),
    ]);
    await expect(new DeletePost(testbed).execute({ actor: editor, postId })).rejects.toBeInstanceOf(
      PostNotFoundError,
    );
  });

  it('never sees posts of another workspace', async () => {
    const { testbed, postId } = await createPost();

    await expect(
      new DeletePost(testbed).execute({ actor: actorOf('EDITOR', 'ws-2'), postId }),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    expect(testbed.unitOfWork.state.posts.has(postId)).toBe(true);
  });
});

describe('UpdateVariant', () => {
  it('saves the editor state with optimistic locking', async () => {
    const { testbed, postId } = await createPost();
    const [linkedin] = variantsOf(testbed, postId);
    if (!linkedin) {
      throw new Error('missing variant');
    }
    const update = new UpdateVariant(testbed);

    await update.execute({
      actor: editor,
      variantId: linkedin.id,
      version: 0,
      patch: { text: 'Hallo Köln', hashtags: ['Koeln'], aiWarnings: [] },
    });
    await expect(
      update.execute({ actor: editor, variantId: linkedin.id, version: 0, patch: { text: 'Zu spät' } }),
    ).rejects.toBeInstanceOf(VersionConflictError);

    expect(testbed.unitOfWork.state.variants.get(linkedin.id)).toMatchObject({
      text: 'Hallo Köln',
      hashtags: ['Koeln'],
      version: 1,
    });
  });

  it('refuses changes to a published variant', async () => {
    const { testbed, postId } = await createPost();
    const [linkedin] = variantsOf(testbed, postId);
    if (!linkedin) {
      throw new Error('missing variant');
    }
    testbed.unitOfWork.state.variants.set(linkedin.id, { ...linkedin, status: 'PUBLISHED' });

    await expect(
      new UpdateVariant(testbed).execute({
        actor: editor,
        variantId: linkedin.id,
        version: 0,
        patch: { text: 'x' },
      }),
    ).rejects.toBeInstanceOf(VariantLockedError);
  });

  it('turns an edited failed variant into a draft, keeps a plan and leaves one in doubt alone', async () => {
    const { testbed, postId } = await createPost();
    const [linkedin] = variantsOf(testbed, postId);
    if (!linkedin) {
      throw new Error('missing variant');
    }
    const edit = (status: PostVariant['status']) => {
      testbed.unitOfWork.state.variants.set(linkedin.id, { ...linkedin, status, version: 0 });
      return new UpdateVariant(testbed).execute({
        actor: editor,
        variantId: linkedin.id,
        version: 0,
        patch: { text: 'Neu' },
      });
    };

    for (const [status, after] of [
      ['FAILED', 'DRAFT'],
      ['CANCELED', 'DRAFT'],
      ['SCHEDULED', 'SCHEDULED'],
    ] as const) {
      await edit(status);
      expect(testbed.unitOfWork.state.variants.get(linkedin.id)?.status).toBe(after);
    }
    await expect(edit('NEEDS_ATTENTION')).rejects.toBeInstanceOf(VariantLockedError);
  });

  it('writes only inside the scope of the actor', async () => {
    const { testbed } = await createPost();
    const store = testbed.unitOfWork;

    await expect(
      store.run({ userId: 'u', organizationId: 'org-1', workspaceId: 'ws-2' }, (scoped) =>
        scoped.posts.insert({
          id: 'post-x',
          workspaceId: 'ws-1',
          brief: '',
          language: 'de',
          styleId: null,
          brandVoiceId: null,
          ideaId: null,
          createdById: null,
          version: 0,
        }),
      ),
    ).rejects.toBeInstanceOf(ScopeViolation);
  });
});
