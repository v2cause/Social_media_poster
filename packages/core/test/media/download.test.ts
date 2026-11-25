import { describe, expect, it } from 'vitest';

import {
  downloadFileName,
  MediaNotFoundError,
  MediaNotReadyError,
  PrepareMediaDownload,
  type MediaAsset,
} from '../../src';
import { actorOf } from '../in-memory-content';
import { createMediaTestbed, type MediaTestbed } from '../in-memory-media';

// ADR 0048: the download is the clean rendition x_image as JPEG, never the original.

const viewer = actorOf('VIEWER');

function asset(testbed: MediaTestbed, status: MediaAsset['status']): MediaAsset {
  const item: MediaAsset = {
    id: 'chart',
    workspaceId: 'ws-1',
    status,
    fileName: 'Wachstum 2026.png',
    declaredMimeType: 'image/png',
    declaredSize: 1000,
    storageKey: 'ws/ws-1/assets/chart/original',
    mimeType: 'image/png',
    sizeBytes: 1000,
    width: 1200,
    height: 675,
    sha256: 'hash',
    rejectReason: null,
    altText: null,
    uploadedById: viewer.userId,
    version: 1,
    processedAt: new Date('2026-10-16T11:00:00Z'),
    deletedAt: null,
  };
  testbed.unitOfWork.state.assets.set(item.id, item);
  testbed.storage.upload(item.storageKey, new Uint8Array(1000), 'image/png');
  return item;
}

describe('PrepareMediaDownload', () => {
  it('signs a download of the x_image rendition under the name of the asset', async () => {
    const media = createMediaTestbed();
    asset(media, 'READY');

    const download = await new PrepareMediaDownload(media).execute({ actor: viewer, assetId: 'chart' });

    expect(media.processor.renders).toEqual([
      expect.objectContaining({ resize: { width: 1200, height: 675 }, format: 'jpeg', extract: null }),
    ]);
    expect(download).toEqual({
      url: 'https://storage.test/ws/ws-1/assets/chart/renditions/x_image-full.jpg?signed',
      fileName: 'Wachstum 2026.jpg',
      expiresAt: new Date(media.clock.now().getTime() + 3600 * 1000),
    });
  });

  it('refuses assets that are not ready or do not exist', async () => {
    const media = createMediaTestbed();
    asset(media, 'PROCESSING');
    const prepare = new PrepareMediaDownload(media);

    await expect(prepare.execute({ actor: viewer, assetId: 'chart' })).rejects.toBeInstanceOf(
      MediaNotReadyError,
    );
    await expect(prepare.execute({ actor: viewer, assetId: 'missing' })).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );
  });
});

describe('downloadFileName', () => {
  it('replaces the extension with .jpg', () => {
    expect(downloadFileName('team.jpeg')).toBe('team.jpg');
    expect(downloadFileName('plan')).toBe('plan.jpg');
    expect(downloadFileName('.png')).toBe('image.jpg');
  });
});
