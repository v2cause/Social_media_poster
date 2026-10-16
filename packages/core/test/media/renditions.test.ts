import { describe, expect, it } from 'vitest';

import {
  CropOutOfBoundsError,
  MediaNotFoundError,
  MediaNotReadyError,
  NotPermittedError,
  RenderAttachedMedia,
  RenderRendition,
  RenditionNotPossibleError,
  RenditionTooLargeError,
  SetVariantMedia,
  VariantLockedError,
  VariantMediaInvalidError,
  VariantNotFoundError,
  VersionConflictError,
  type MediaAsset,
  type VariantMediaItem,
} from '../../src';
import { actorOf } from '../in-memory-content';
import { createMediaTestbed, type MediaTestbed } from '../in-memory-media';

// Guide step 3.4: the media of a variant with crop, letterbox and alt text, the renditions they
// need for their platform, and the byte limits of the profiles.

const editor = actorOf('EDITOR');
const MB = 1024 * 1024;

function readyAsset(testbed: MediaTestbed, id: string, width: number, height: number): MediaAsset {
  const asset: MediaAsset = {
    id,
    workspaceId: 'ws-1',
    status: 'READY',
    fileName: `${id}.jpg`,
    declaredMimeType: 'image/jpeg',
    declaredSize: 1000,
    storageKey: `ws/ws-1/assets/${id}/original`,
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    width,
    height,
    sha256: 'hash',
    rejectReason: null,
    altText: null,
    uploadedById: editor.userId,
    version: 2,
    processedAt: new Date('2026-10-16T11:00:00Z'),
    deletedAt: null,
  };
  testbed.unitOfWork.state.assets.set(id, asset);
  testbed.storage.upload(asset.storageKey, new Uint8Array(1000), 'image/jpeg');
  return asset;
}

function variant(
  testbed: MediaTestbed,
  platform: 'INSTAGRAM' | 'X' = 'INSTAGRAM',
  status = 'DRAFT' as const,
) {
  testbed.unitOfWork.state.variants.set('variant-1', {
    id: 'variant-1',
    workspaceId: 'ws-1',
    platform,
    status,
    version: 3,
  });
}

const item = (assetId: string, overrides: Partial<VariantMediaItem> = {}): VariantMediaItem => ({
  assetId,
  crop: null,
  letterbox: false,
  altText: null,
  ...overrides,
});

const attach = (testbed: MediaTestbed, items: VariantMediaItem[], version = 3) =>
  new SetVariantMedia(testbed).execute({ actor: editor, variantId: 'variant-1', version, items });

describe('SetVariantMedia', () => {
  it('attaches media in order and queues the renditions of the platform', async () => {
    const testbed = createMediaTestbed();
    variant(testbed);
    readyAsset(testbed, 'square', 2000, 2000);
    readyAsset(testbed, 'portrait', 3000, 4000);
    readyAsset(testbed, 'panorama', 3000, 1000);

    await attach(testbed, [
      item('square', { altText: '  Das Team  ' }),
      item('portrait', { crop: { x: 0, y: 250, width: 3000, height: 3750 } }),
      // 3:1 without crop or letterbox does not fit Instagram yet: no rendition until it does.
      item('panorama'),
    ]);

    const uses = [...testbed.unitOfWork.state.postMedia.values()].sort((a, b) => a.position - b.position);
    expect(uses.map((use) => [use.assetId, use.position, use.altText])).toEqual([
      ['square', 0, 'Das Team'],
      ['portrait', 1, null],
      ['panorama', 2, null],
    ]);
    expect(testbed.unitOfWork.state.variants.get('variant-1')?.version).toBe(4);
    expect(testbed.jobs.renders).toEqual([
      expect.objectContaining({ assetId: 'square', profile: 'instagram_feed', cropHash: 'full' }),
      expect.objectContaining({
        assetId: 'portrait',
        profile: 'instagram_feed',
        cropHash: 'x0y250w3000h3750',
      }),
    ]);
    expect(testbed.jobs.renders[0]?.postMediaId).toBe(uses[0]?.id);
  });

  it('replaces the media of the variant and takes letterbox for any ratio', async () => {
    const testbed = createMediaTestbed();
    variant(testbed);
    readyAsset(testbed, 'square', 2000, 2000);
    readyAsset(testbed, 'panorama', 3000, 1000);
    await attach(testbed, [item('square')]);

    await attach(testbed, [item('panorama', { letterbox: true })], 4);

    expect([...testbed.unitOfWork.state.postMedia.values()].map((use) => use.assetId)).toEqual(['panorama']);
    expect(testbed.jobs.renders.at(-1)).toMatchObject({ assetId: 'panorama', cropHash: 'full-lb' });
  });

  it('refuses what a variant cannot hold and changes nothing then', async () => {
    const testbed = createMediaTestbed();
    variant(testbed);
    readyAsset(testbed, 'square', 2000, 2000);
    const processing = { ...readyAsset(testbed, 'processing', 100, 100), status: 'PROCESSING' as const };
    testbed.unitOfWork.state.assets.set('processing', processing);
    const otherWorkspace = { ...readyAsset(testbed, 'foreign', 100, 100), workspaceId: 'ws-2' };
    testbed.unitOfWork.state.assets.set('foreign', otherWorkspace);

    const cases: [() => Promise<void>, unknown][] = [
      [() => attach(testbed, [item('square')], 2), VersionConflictError],
      [() => attach(testbed, [item('missing')]), MediaNotFoundError],
      [() => attach(testbed, [item('foreign')]), MediaNotFoundError],
      [() => attach(testbed, [item('processing')]), MediaNotReadyError],
      [
        () => attach(testbed, [item('square', { crop: { x: 1500, y: 0, width: 600, height: 600 } })]),
        CropOutOfBoundsError,
      ],
      [() => attach(testbed, [item('square'), item('square')]), VariantMediaInvalidError],
      [
        () =>
          attach(
            testbed,
            Array.from({ length: 21 }, (_, index) => item(`asset-${String(index)}`)),
          ),
        VariantMediaInvalidError,
      ],
      [
        () =>
          new SetVariantMedia(testbed).execute({
            actor: actorOf('VIEWER'),
            variantId: 'variant-1',
            version: 3,
            items: [item('square')],
          }),
        NotPermittedError,
      ],
      [
        () =>
          new SetVariantMedia(testbed).execute({
            actor: editor,
            variantId: 'unknown',
            version: 3,
            items: [],
          }),
        VariantNotFoundError,
      ],
    ];
    for (const [call, error] of cases) {
      await expect(call()).rejects.toBeInstanceOf(error);
    }
    expect(testbed.unitOfWork.state.postMedia.size).toBe(0);
    expect(testbed.unitOfWork.state.variants.get('variant-1')?.version).toBe(3);
    expect(testbed.jobs.renders).toEqual([]);
  });

  it('leaves the media of a variant that is being published alone', async () => {
    const testbed = createMediaTestbed();
    testbed.unitOfWork.state.variants.set('variant-1', {
      id: 'variant-1',
      workspaceId: 'ws-1',
      platform: 'X',
      status: 'PUBLISHING',
      version: 3,
    });
    readyAsset(testbed, 'square', 2000, 2000);

    await expect(attach(testbed, [item('square')])).rejects.toBeInstanceOf(VariantLockedError);
  });
});

describe('RenderRendition and media.render', () => {
  it('renders the crop for Instagram as JPEG once and stores it under the crop hash', async () => {
    const testbed = createMediaTestbed();
    variant(testbed);
    readyAsset(testbed, 'portrait', 3000, 4000);
    await attach(testbed, [item('portrait', { crop: { x: 0, y: 250, width: 3000, height: 3750 } })]);
    const [job] = testbed.jobs.renders;
    if (!job) {
      throw new Error('no render job');
    }

    await expect(new RenderAttachedMedia(testbed).execute(job)).resolves.toBe('RENDERED');
    await expect(new RenderAttachedMedia(testbed).execute(job)).resolves.toBe('RENDERED');

    expect(testbed.processor.renders).toEqual([
      {
        extract: { x: 0, y: 250, width: 3000, height: 3750 },
        resize: { width: 1080, height: 1350 },
        extend: null,
        format: 'jpeg',
        quality: 85,
      },
    ]);
    expect([...testbed.unitOfWork.state.renditions.values()]).toEqual([
      expect.objectContaining({
        assetId: 'portrait',
        profile: 'instagram_feed',
        cropHash: 'x0y250w3000h3750',
        storageKey: 'ws/ws-1/assets/portrait/renditions/instagram_feed-x0y250w3000h3750.jpg',
        mimeType: 'image/jpeg',
        width: 1080,
        height: 1350,
      }),
    ]);
    expect(
      testbed.storage.objects.has('ws/ws-1/assets/portrait/renditions/instagram_feed-x0y250w3000h3750.jpg'),
    ).toBe(true);
  });

  it('skips jobs for uses that were removed or cropped differently since', async () => {
    const testbed = createMediaTestbed();
    variant(testbed);
    readyAsset(testbed, 'square', 2000, 2000);
    await attach(testbed, [item('square')]);
    const [job] = testbed.jobs.renders;
    if (!job) {
      throw new Error('no render job');
    }
    await attach(testbed, [item('square', { crop: { x: 0, y: 0, width: 1000, height: 1000 } })], 4);

    await expect(new RenderAttachedMedia(testbed).execute(job)).resolves.toBe('SKIPPED');
    expect(testbed.processor.renders).toEqual([]);
  });

  it('lowers the quality, then the size, until the file fits the byte limit', async () => {
    const testbed = createMediaTestbed();
    readyAsset(testbed, 'detailed', 6000, 4000);
    // Only quality 50 at three quarters of the size fits the 5 MB of X.
    testbed.processor.renditionBytes = (options) =>
      options.quality <= 50 && options.resize.width <= 3072 ? 4 * MB : 6 * MB;
    const input = {
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      assetId: 'detailed',
      profile: 'x_image' as const,
      crop: null,
      letterbox: false,
    };

    const rendition = await new RenderRendition(testbed).execute(input);

    expect(testbed.processor.renders.map((options) => [options.quality, options.resize.width])).toEqual([
      [85, 4096],
      [75, 4096],
      [65, 4096],
      [50, 3072],
    ]);
    expect(rendition).toMatchObject({ width: 3072, height: 2048, sizeBytes: 4 * MB });

    testbed.processor.renditionBytes = () => 6 * MB;
    await expect(
      new RenderRendition(testbed).execute({ ...input, profile: 'facebook_photo' }),
    ).rejects.toBeInstanceOf(RenditionTooLargeError);
  });

  it('refuses renditions the profile does not allow and assets that are not ready', async () => {
    const testbed = createMediaTestbed();
    readyAsset(testbed, 'panorama', 3000, 1000);
    const pending = { ...readyAsset(testbed, 'pending', 100, 100), status: 'PROCESSING' as const };
    testbed.unitOfWork.state.assets.set('pending', pending);
    const input = {
      organizationId: 'org-1',
      workspaceId: 'ws-1',
      assetId: 'panorama',
      profile: 'instagram_feed' as const,
      crop: null,
      letterbox: false,
    };

    await expect(new RenderRendition(testbed).execute(input)).rejects.toBeInstanceOf(
      RenditionNotPossibleError,
    );
    await expect(
      new RenderRendition(testbed).execute({ ...input, assetId: 'pending' }),
    ).rejects.toBeInstanceOf(MediaNotReadyError);
    await expect(new RenderRendition(testbed).execute({ ...input, letterbox: true })).resolves.toMatchObject({
      width: 1080,
      height: 566,
      cropHash: 'full-lb',
    });
  });
});
