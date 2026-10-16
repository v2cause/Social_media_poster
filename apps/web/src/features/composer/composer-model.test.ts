import type { GeneratedVariantDto, MediaAssetDto, PostDto, VariantDto } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import {
  composerReducer,
  initialState,
  isDirty,
  isMediaDirty,
  isPostDirty,
  isTextDirty,
  skippedResults,
  type ComposerState,
  type DraftMedia,
} from './composer-model';

/** The planning fields of a draft that was never planned. */
const unplanned = {
  socialAccountId: null,
  scheduledAt: null,
  scheduledTimezone: null,
  publishedAt: null,
  externalUrl: null,
  failureCode: null,
  isDryRun: false,
};

const post: PostDto = {
  id: '0199f0a0-0000-7000-8000-000000000010',
  brief: 'Neues Büro',
  language: 'de',
  styleId: null,
  brandVoiceId: null,
  ideaId: null,
  version: 3,
  createdAt: '2026-10-16T10:00:00.000Z',
  updatedAt: '2026-10-16T10:00:00.000Z',
  variants: [
    {
      id: 'v-x',
      postId: '0199f0a0-0000-7000-8000-000000000010',
      platform: 'X',
      targetKey: 't2',
      text: '',
      hashtags: [],
      firstComment: null,
      linkUrl: null,
      aiWarnings: [],
      status: 'DRAFT',
      media: [],
      ...unplanned,
      version: 0,
      updatedAt: '2026-10-16T10:00:00.000Z',
    },
    {
      id: 'v-linkedin',
      postId: '0199f0a0-0000-7000-8000-000000000010',
      platform: 'LINKEDIN',
      targetKey: 't1',
      text: 'Alt',
      hashtags: [],
      firstComment: null,
      linkUrl: null,
      aiWarnings: [],
      status: 'DRAFT',
      media: [],
      ...unplanned,
      version: 2,
      updatedAt: '2026-10-16T10:00:00.000Z',
    },
  ],
};

const result = (variantId: string, text: string): GeneratedVariantDto => ({
  variantId,
  targetKey: 't1',
  platform: 'LINKEDIN',
  hook: text,
  text,
  hashtags: ['Neu'],
  firstComment: null,
  callToAction: null,
  altTexts: [],
  warnings: ['Quelle fehlt'],
  count: { length: text.length, max: 3000, overLimit: false },
  issues: [],
  forbiddenWords: ['Synergie'],
  autoShortened: false,
});

const loaded = (): ComposerState =>
  composerReducer(
    initialState({
      brief: '',
      language: 'de',
      styleId: null,
      brandVoiceId: null,
      ideaId: null,
      platforms: [],
    }),
    { type: 'loaded', post },
  );

describe('composerReducer', () => {
  it('loads a post with its variants in target order and nothing to save', () => {
    const state = loaded();

    expect(state.variants.map((variant) => variant.id)).toEqual(['v-linkedin', 'v-x']);
    expect(state.post.platforms).toEqual(['LINKEDIN', 'X']);
    expect(state.activeVariantId).toBe('v-linkedin');
    expect(isDirty(state)).toBe(false);
  });

  it('tracks changes until the save of that revision', () => {
    const changed = composerReducer(loaded(), { type: 'post-changed', patch: { brief: 'Neu' } });
    const changedAgain = composerReducer(changed, { type: 'post-changed', patch: { brief: 'Neuer' } });
    // The save of the first revision returns while the second is pending.
    const saved = composerReducer(changedAgain, {
      type: 'post-saved',
      post: { ...post, version: 4 },
      revision: 1,
    });

    expect(isPostDirty(changed)).toBe(true);
    expect(saved.version).toBe(4);
    expect(isPostDirty(saved)).toBe(true);
    expect(
      isPostDirty(composerReducer(saved, { type: 'post-saved', post: { ...post, version: 5 }, revision: 2 })),
    ).toBe(false);
  });

  it('never lets a generation overwrite a variant the user edited during it', () => {
    let state = composerReducer(loaded(), { type: 'generation-started', variantIds: ['v-linkedin', 'v-x'] });
    state = composerReducer(state, {
      type: 'variant-changed',
      variantId: 'v-x',
      patch: { text: 'Mein Text' },
    });
    const results = [result('v-linkedin', 'KI LinkedIn'), result('v-x', 'KI X')];

    expect(skippedResults(state, results)).toBe(1);
    state = composerReducer(state, { type: 'generated', variants: results });

    const [linkedin, x] = state.variants;
    expect(linkedin).toMatchObject({
      text: 'KI LinkedIn',
      hashtags: ['Neu'],
      aiWarnings: ['Quelle fehlt'],
      edited: false,
      check: { forbiddenWords: ['Synergie'] },
    });
    expect(x).toMatchObject({ text: 'Mein Text', edited: true });
    expect(isDirty(state)).toBe(true);
  });

  it('keeps unsaved texts when a save of the post adds or removes variants', () => {
    let state = composerReducer(loaded(), {
      type: 'variant-changed',
      variantId: 'v-linkedin',
      patch: { text: 'Lokal' },
    });
    state = composerReducer(state, { type: 'activated', variantId: 'v-x' });
    const linkedin = post.variants[1];
    if (!linkedin) {
      throw new Error('missing variant');
    }
    state = composerReducer(state, {
      type: 'post-saved',
      revision: 0,
      post: {
        ...post,
        version: 4,
        variants: [
          linkedin,
          { ...linkedin, id: 'v-instagram', platform: 'INSTAGRAM', targetKey: 't2', text: '' },
        ],
      },
    });

    expect(state.variants.map((variant) => [variant.id, variant.text])).toEqual([
      ['v-linkedin', 'Lokal'],
      ['v-instagram', ''],
    ]);
    expect(state.activeVariantId).toBe('v-linkedin');
  });

  it('saves media apart from the text and takes fresh thumbnails only for the saved revision', () => {
    const asset = (id: string, url: string): MediaAssetDto => ({
      id,
      status: 'READY',
      fileName: `${id}.jpg`,
      mimeType: 'image/jpeg',
      sizeBytes: 1000,
      width: 1600,
      height: 1200,
      rejectReason: null,
      altText: null,
      usageCount: 0,
      thumbnails: [{ width: 320, height: 240, url }],
      version: 2,
      createdAt: '2026-10-16T10:00:00.000Z',
      updatedAt: '2026-10-16T10:00:00.000Z',
    });
    const media = (id: string): DraftMedia => ({
      assetId: id,
      crop: null,
      letterbox: false,
      altText: null,
      asset: asset(id, `https://storage.test/${id}?old`),
    });
    let state = composerReducer(loaded(), { type: 'media-changed', variantId: 'v-x', media: [media('a')] });
    const x = () => {
      const variant = state.variants.find((candidate) => candidate.id === 'v-x');
      if (!variant) {
        throw new Error('missing variant');
      }
      return variant;
    };
    expect(x()).toMatchObject({ mediaRevision: 1, savedMediaRevision: 0 });
    expect(isMediaDirty(x())).toBe(true);
    expect(isTextDirty(x())).toBe(false);

    // The server answers with fresh signed URLs and the next version of the variant.
    const saved = (urlSuffix: string): VariantDto => ({
      ...(post.variants[0] as VariantDto),
      version: 1,
      media: [
        {
          id: 'use-a',
          assetId: 'a',
          position: 0,
          crop: null,
          letterbox: false,
          altText: null,
          asset: asset('a', `https://storage.test/a?${urlSuffix}`),
        },
      ],
    });
    state = composerReducer(state, { type: 'media-saved', variant: saved('fresh'), mediaRevision: 1 });
    expect(x()).toMatchObject({ version: 1, savedMediaRevision: 1 });
    expect(x().media[0]?.asset.thumbnails[0]?.url).toBe('https://storage.test/a?fresh');
    expect(isDirty(state)).toBe(false);

    // A change while the save runs stays local.
    state = composerReducer(state, {
      type: 'media-changed',
      variantId: 'v-x',
      media: [media('a'), media('b')],
    });
    state = composerReducer(state, { type: 'media-saved', variant: saved('late'), mediaRevision: 1 });
    expect(x().media.map((item) => item.assetId)).toEqual(['a', 'b']);
    expect(isMediaDirty(x())).toBe(true);
  });
});
