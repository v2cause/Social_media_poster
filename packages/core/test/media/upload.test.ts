import { describe, expect, it } from 'vitest';

import {
  CompleteUpload,
  DeleteMedia,
  MediaInUseError,
  MediaNotFoundError,
  MediaTooLargeError,
  MediaTypeNotAllowedError,
  NotPermittedError,
  ProcessAsset,
  RequestUpload,
  StorageQuotaExceededError,
  UpdateMediaAltText,
  UploadMissingError,
  VersionConflictError,
} from '../../src';
import { actorOf } from '../in-memory-content';
import { createMediaTestbed, JPEG_BYTES, type MediaTestbed } from '../in-memory-media';

const editor = actorOf('EDITOR');
const MB = 1024 * 1024;

async function requested(testbed: MediaTestbed, overrides: { size?: number; mimeType?: string } = {}) {
  return new RequestUpload(testbed).execute({
    actor: editor,
    fileName: 'Sommerfest 2026.jpg',
    mimeType: overrides.mimeType ?? 'image/jpeg',
    size: overrides.size ?? JPEG_BYTES.byteLength,
  });
}

/** An asset whose file arrived and whose upload is reported complete. */
async function uploaded(testbed: MediaTestbed, bytes: Uint8Array = JPEG_BYTES) {
  const ticket = await requested(testbed, { size: bytes.byteLength });
  testbed.storage.upload(ticket.asset.storageKey, bytes, 'image/jpeg');
  return new CompleteUpload(testbed).execute({ actor: editor, assetId: ticket.asset.id });
}

const job = (assetId: string) => ({ organizationId: 'org-1', workspaceId: 'ws-1', assetId });

describe('RequestUpload', () => {
  it('creates an asset waiting for its file and a presigned PUT under the workspace', async () => {
    const testbed = createMediaTestbed();

    const ticket = await requested(testbed);

    expect(ticket.asset).toMatchObject({
      status: 'PENDING_UPLOAD',
      fileName: 'Sommerfest 2026.jpg',
      declaredMimeType: 'image/jpeg',
      storageKey: `ws/ws-1/assets/${ticket.asset.id}/original`,
      uploadedById: editor.userId,
    });
    expect(ticket.upload).toMatchObject({ method: 'PUT', headers: { 'Content-Type': 'image/jpeg' } });
    expect(ticket.expiresAt.toISOString()).toBe('2026-10-16T12:05:00.000Z');
    expect(testbed.unitOfWork.locks).toBe(1);
  });

  it('refuses other types, empty and too large files, and viewers', async () => {
    const testbed = createMediaTestbed();

    await expect(requested(testbed, { mimeType: 'image/svg+xml' })).rejects.toBeInstanceOf(
      MediaTypeNotAllowedError,
    );
    await expect(requested(testbed, { mimeType: 'image/heic' })).rejects.toBeInstanceOf(
      MediaTypeNotAllowedError,
    );
    await expect(requested(testbed, { size: 0 })).rejects.toBeInstanceOf(MediaTooLargeError);
    await expect(requested(testbed, { size: 20 * MB + 1 })).rejects.toBeInstanceOf(MediaTooLargeError);
    await expect(
      new RequestUpload(testbed).execute({
        actor: actorOf('VIEWER'),
        fileName: 'a.jpg',
        mimeType: 'image/jpeg',
        size: 10,
      }),
    ).rejects.toBeInstanceOf(NotPermittedError);
    expect(testbed.unitOfWork.state.assets.size).toBe(0);
  });

  it('counts announced and measured sizes against the storage quota of the workspace', async () => {
    const testbed = createMediaTestbed(25 * MB);
    await requested(testbed, { size: 10 * MB });
    await requested(testbed, { size: 10 * MB });

    await expect(requested(testbed, { size: 6 * MB })).rejects.toBeInstanceOf(StorageQuotaExceededError);
    await expect(requested(testbed, { size: 5 * MB })).resolves.toBeDefined();
  });

  it('keeps file names to one clean line for display', async () => {
    const testbed = createMediaTestbed();

    const ticket = await new RequestUpload(testbed).execute({
      actor: editor,
      fileName: '../secret\nname.jpg',
      mimeType: 'IMAGE/JPEG',
      size: 10,
    });

    expect(ticket.asset.fileName).toBe('.._secret name.jpg');
    expect(ticket.asset.storageKey).not.toContain('secret');
    expect(ticket.asset.declaredMimeType).toBe('image/jpeg');
  });
});

describe('CompleteUpload', () => {
  it('queues media.process once the file is in the storage', async () => {
    const testbed = createMediaTestbed();

    const asset = await uploaded(testbed);

    expect(asset).toMatchObject({ status: 'PROCESSING', sizeBytes: JPEG_BYTES.byteLength });
    expect(testbed.jobs.jobs).toEqual([job(asset.id)]);
  });

  it('answers 409 before the upload and queues a processing asset again when asked twice', async () => {
    const testbed = createMediaTestbed();
    const ticket = await requested(testbed);

    await expect(
      new CompleteUpload(testbed).execute({ actor: editor, assetId: ticket.asset.id }),
    ).rejects.toBeInstanceOf(UploadMissingError);

    testbed.storage.upload(ticket.asset.storageKey, JPEG_BYTES, 'image/jpeg');
    await new CompleteUpload(testbed).execute({ actor: editor, assetId: ticket.asset.id });
    await new CompleteUpload(testbed).execute({ actor: editor, assetId: ticket.asset.id });
    expect(testbed.jobs.jobs).toHaveLength(2);
  });

  it('rejects and deletes a file that differs from what was announced', async () => {
    const testbed = createMediaTestbed();
    const ticket = await requested(testbed, { size: 10 });
    testbed.storage.upload(ticket.asset.storageKey, new Uint8Array(5000), 'image/jpeg');

    const asset = await new CompleteUpload(testbed).execute({ actor: editor, assetId: ticket.asset.id });

    expect(asset).toMatchObject({ status: 'REJECTED', rejectReason: 'SIZE_MISMATCH' });
    expect(testbed.storage.objects.has(ticket.asset.storageKey)).toBe(false);
    expect(testbed.jobs.jobs).toEqual([]);
  });

  it('does not know assets of other workspaces', async () => {
    const testbed = createMediaTestbed();
    const ticket = await requested(testbed);

    await expect(
      new CompleteUpload(testbed).execute({ actor: actorOf('EDITOR', 'ws-2'), assetId: ticket.asset.id }),
    ).rejects.toBeInstanceOf(MediaNotFoundError);
  });
});

describe('ProcessAsset', () => {
  it('measures the image, stores two WebP thumbnails and marks the asset ready', async () => {
    const testbed = createMediaTestbed();
    const asset = await uploaded(testbed);

    await expect(new ProcessAsset(testbed).execute(job(asset.id))).resolves.toBe('READY');

    const stored = testbed.unitOfWork.state.assets.get(asset.id);
    expect(stored).toMatchObject({
      status: 'READY',
      mimeType: 'image/jpeg',
      width: 4000,
      height: 3000,
      sha256: `sha256-of-${String(JPEG_BYTES.byteLength)}-bytes`,
    });
    const thumbnails = [...testbed.unitOfWork.state.renditions.values()];
    expect(thumbnails.map((rendition) => [rendition.profile, rendition.width, rendition.height])).toEqual([
      ['thumb_320', 320, 240],
      ['thumb_640', 640, 480],
    ]);
    expect(testbed.storage.objects.has(`ws/ws-1/assets/${asset.id}/renditions/thumb_320-full.webp`)).toBe(
      true,
    );
  });

  it('refuses files that are no image, whatever they were called', async () => {
    const testbed = createMediaTestbed();
    const html = new TextEncoder().encode('<!DOCTYPE html><html><body>not an image</body></html>');
    const asset = await uploaded(testbed, html);

    await expect(new ProcessAsset(testbed).execute(job(asset.id))).resolves.toBe('REJECTED');

    expect(testbed.unitOfWork.state.assets.get(asset.id)).toMatchObject({
      status: 'REJECTED',
      rejectReason: 'NOT_AN_IMAGE',
    });
    expect([...testbed.storage.objects.keys()].some((key) => key.includes(asset.id))).toBe(false);
  });

  it('names HEIC, animations and images the decoder refuses', async () => {
    const heic = Uint8Array.from([0, 0, 0, 24, ...new TextEncoder().encode('ftypheic'), 0, 0, 0, 0]);
    const cases: [Uint8Array, (testbed: MediaTestbed) => void, string][] = [
      [heic, () => undefined, 'HEIC_NOT_SUPPORTED'],
      [
        JPEG_BYTES,
        (testbed) => {
          testbed.processor.info = { format: 'gif', width: 10, height: 10, frames: 3 };
        },
        'ANIMATED_NOT_SUPPORTED',
      ],
      [
        JPEG_BYTES,
        (testbed) => {
          testbed.processor.rejectWith('DIMENSIONS_TOO_LARGE');
        },
        'DIMENSIONS_TOO_LARGE',
      ],
    ];
    for (const [bytes, arrange, reason] of cases) {
      const testbed = createMediaTestbed();
      const asset = await uploaded(testbed, bytes);
      arrange(testbed);

      await expect(new ProcessAsset(testbed).execute(job(asset.id))).resolves.toBe('REJECTED');
      expect(testbed.unitOfWork.state.assets.get(asset.id)?.rejectReason).toBe(reason);
    }
  });

  it('skips assets that are not processing any more', async () => {
    const testbed = createMediaTestbed();
    const asset = await uploaded(testbed);
    await new ProcessAsset(testbed).execute(job(asset.id));

    await expect(new ProcessAsset(testbed).execute(job(asset.id))).resolves.toBe('SKIPPED');
    await expect(new ProcessAsset(testbed).execute(job('missing'))).resolves.toBe('SKIPPED');
  });
});

describe('UpdateMediaAltText and DeleteMedia', () => {
  it('changes the alt text with the version the client read', async () => {
    const testbed = createMediaTestbed();
    const asset = await uploaded(testbed);
    const update = new UpdateMediaAltText(testbed);

    const changed = await update.execute({
      actor: editor,
      assetId: asset.id,
      version: asset.version,
      altText: '  Das Team beim Sommerfest  ',
    });

    expect(changed).toMatchObject({ altText: 'Das Team beim Sommerfest', version: asset.version + 1 });
    await expect(
      update.execute({ actor: editor, assetId: asset.id, version: asset.version, altText: 'stale' }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    await expect(
      update.execute({ actor: editor, assetId: asset.id, version: changed.version, altText: '   ' }),
    ).resolves.toMatchObject({ altText: null });
  });

  it('removes unused assets from the library and keeps the ones a variant uses', async () => {
    const testbed = createMediaTestbed();
    const unused = await uploaded(testbed);
    const used = await uploaded(testbed);
    testbed.unitOfWork.state.usage.set(used.id, 1);
    const remove = new DeleteMedia(testbed);

    await remove.execute({ actor: editor, assetId: unused.id });

    expect(testbed.unitOfWork.state.assets.get(unused.id)?.deletedAt).toEqual(
      new Date('2026-10-16T12:00:00Z'),
    );
    expect(testbed.unitOfWork.state.audit).toMatchObject([{ action: 'media.delete', targetId: unused.id }]);
    await expect(remove.execute({ actor: editor, assetId: unused.id })).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );
    await expect(remove.execute({ actor: editor, assetId: used.id })).rejects.toBeInstanceOf(MediaInUseError);
  });
});
