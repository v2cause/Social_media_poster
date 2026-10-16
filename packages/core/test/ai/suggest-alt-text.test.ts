import { describe, expect, it } from 'vitest';

import {
  AiCallFailedError,
  MediaNotFoundError,
  MediaNotReadyError,
  NotPermittedError,
  SuggestAltText,
  type MediaAsset,
} from '../../src';
import { createAiTestbed, failureOf, reportOf, type AiTestbed } from '../in-memory-ai';
import { actorOf } from '../in-memory-content';
import { createMediaTestbed, type MediaTestbed } from '../in-memory-media';

// Guide step 3.5: the image goes to the AI at 1568 px on its longest side, the call is metered,
// and the suggestion is only returned, never saved.

const editor = actorOf('EDITOR');

function setup(): { ai: AiTestbed; media: MediaTestbed; suggest: SuggestAltText } {
  const ai = createAiTestbed();
  const media = createMediaTestbed();
  const asset: MediaAsset = {
    id: 'photo',
    workspaceId: 'ws-1',
    status: 'READY',
    fileName: 'team.jpg',
    declaredMimeType: 'image/jpeg',
    declaredSize: 1000,
    storageKey: 'ws/ws-1/assets/photo/original',
    mimeType: 'image/jpeg',
    sizeBytes: 1000,
    width: 4000,
    height: 3000,
    sha256: 'hash',
    rejectReason: null,
    altText: null,
    uploadedById: editor.userId,
    version: 2,
    processedAt: new Date('2026-10-16T11:00:00Z'),
    deletedAt: null,
  };
  media.unitOfWork.state.assets.set(asset.id, asset);
  media.storage.upload(asset.storageKey, new Uint8Array(1000), 'image/jpeg');
  // The rendition the fake processor renders: three bytes "abc", base64 "YWJj".
  media.processor.renditionBytes = () => 3;
  return { ai, media, suggest: new SuggestAltText(ai.deps, media) };
}

describe('SuggestAltText', () => {
  it('sends the image at 1568 px in the content language and meters the call', async () => {
    const { ai, media, suggest } = setup();
    media.storage.objects.set('ws/ws-1/assets/photo/renditions/ai_vision-full.jpg', {
      bytes: new TextEncoder().encode('abc'),
      contentType: 'image/jpeg',
    });
    ai.provider.altText = () =>
      Promise.resolve({ ok: true, value: '  Das Team\n steht vor dem Büro.  ', report: reportOf() });

    const suggestion = await suggest.execute({ actor: editor, assetId: 'photo', context: ' Sommerfest ' });

    expect(suggestion).toBe('Das Team steht vor dem Büro.');
    expect(media.processor.renders).toEqual([
      expect.objectContaining({ resize: { width: 1568, height: 1176 }, format: 'jpeg', quality: 85 }),
    ]);
    expect(ai.provider.calls).toEqual([
      {
        method: 'suggestAltText',
        effort: 'low',
        input: {
          language: 'de',
          image: { kind: 'base64', mediaType: 'image/jpeg', data: expect.any(String) as string },
          context: 'Sommerfest',
        },
      },
    ]);
    expect(ai.generations).toEqual([
      expect.objectContaining({
        task: 'ALT_TEXT',
        outcome: 'OK',
        input: { assetId: 'photo', language: 'de', withContext: true },
        output: { altText: 'Das Team steht vor dem Büro.' },
      }),
    ]);
    expect(ai.quotaStore.ledger).toHaveLength(1);
    // Nothing is saved on the asset.
    expect(media.unitOfWork.state.assets.get('photo')?.altText).toBeNull();
  });

  it('keeps the rendition for the next suggestion and takes the language of the post', async () => {
    const { ai, media, suggest } = setup();

    await suggest.execute({ actor: editor, assetId: 'photo' });
    await suggest.execute({ actor: editor, assetId: 'photo', language: 'en' });

    expect(media.processor.renders).toHaveLength(1);
    expect(ai.provider.calls.map((call) => (call.input as { language: string }).language)).toEqual([
      'de',
      'en',
    ]);
    expect(ai.provider.calls.map((call) => (call.input as { context: string | null }).context)).toEqual([
      null,
      null,
    ]);
  });

  it('cuts suggestions above 250 characters at a word', async () => {
    const { ai, suggest } = setup();
    ai.provider.altText = () =>
      Promise.resolve({ ok: true, value: `${'Wort '.repeat(60)}Ende.`, report: reportOf() });

    const suggestion = await suggest.execute({ actor: editor, assetId: 'photo' });

    expect(suggestion.length).toBeLessThanOrEqual(250);
    expect(suggestion.endsWith('Wort')).toBe(true);
  });

  it('books failed calls and refuses viewers and images that are not ready', async () => {
    const { ai, media, suggest } = setup();
    ai.provider.altText = () =>
      Promise.resolve({ ok: false, failure: failureOf('REFUSED'), report: reportOf() });

    await expect(suggest.execute({ actor: editor, assetId: 'photo' })).rejects.toBeInstanceOf(
      AiCallFailedError,
    );
    expect(ai.generations.at(-1)).toMatchObject({ task: 'ALT_TEXT', outcome: 'REFUSED', output: null });

    await expect(suggest.execute({ actor: actorOf('VIEWER'), assetId: 'photo' })).rejects.toBeInstanceOf(
      NotPermittedError,
    );
    await expect(suggest.execute({ actor: editor, assetId: 'missing' })).rejects.toBeInstanceOf(
      MediaNotFoundError,
    );
    const pending = media.unitOfWork.state.assets.get('photo');
    if (pending) {
      media.unitOfWork.state.assets.set('photo', { ...pending, status: 'PROCESSING' });
    }
    media.storage.objects.clear();
    media.unitOfWork.state.renditions.clear();
    await expect(suggest.execute({ actor: editor, assetId: 'photo' })).rejects.toBeInstanceOf(
      MediaNotReadyError,
    );
    expect(ai.generations).toHaveLength(1);
  });
});
