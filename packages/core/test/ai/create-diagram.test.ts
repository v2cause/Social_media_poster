import { describe, expect, it } from 'vitest';

import {
  AiCallFailedError,
  CreateDiagram,
  DiagramRejectedError,
  diagramFileName,
  NotPermittedError,
  StorageQuotaExceededError,
  type DiagramRenderer,
} from '../../src';
import { createAiTestbed, failureOf, reportOf, type AiTestbed } from '../in-memory-ai';
import { actorOf } from '../in-memory-content';
import { createMediaTestbed, JPEG_BYTES, type MediaTestbed } from '../in-memory-media';

// ADR 0048: Claude draws the diagram as SVG, the renderer turns it into a JPEG, and the JPEG enters
// the media library the way a finished upload does.

const editor = actorOf('EDITOR');

class RecordingRenderer implements DiagramRenderer {
  readonly calls: { svg: string; size: { width: number; height: number } }[] = [];
  reject: string | null = null;

  render(svg: string, size: { width: number; height: number }): Promise<Uint8Array> {
    this.calls.push({ svg, size });
    return this.reject === null
      ? Promise.resolve(JPEG_BYTES)
      : Promise.reject(new DiagramRejectedError(this.reject));
  }
}

function setup(storageBytes?: number): {
  ai: AiTestbed;
  media: MediaTestbed;
  renderer: RecordingRenderer;
  create: CreateDiagram;
} {
  const ai = createAiTestbed();
  const media = createMediaTestbed(storageBytes);
  const renderer = new RecordingRenderer();
  return { ai, media, renderer, create: new CreateDiagram(ai.deps, media, renderer) };
}

describe('CreateDiagram', () => {
  it('draws the diagram, renders it in the chosen format and hands it to media.process', async () => {
    const { ai, media, renderer, create } = setup();

    const created = await create.execute({
      actor: editor,
      description: '  Unser Onboarding in drei Schritten  ',
      format: 'portrait',
    });

    expect(ai.provider.calls).toEqual([
      expect.objectContaining({
        method: 'generateDiagram',
        effort: 'medium',
        input: expect.objectContaining({
          language: 'de',
          format: 'portrait',
          description: 'Unser Onboarding in drei Schritten',
        }) as unknown,
      }),
    ]);
    expect(renderer.calls).toEqual([
      { svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', size: { width: 1080, height: 1350 } },
    ]);
    expect(created).toMatchObject({
      title: 'Drei Schritte zum Ziel',
      altText: 'Ein Ablauf in drei Schritten.',
    });
    expect(created.asset).toMatchObject({
      status: 'PROCESSING',
      fileName: 'drei-schritte-zum-ziel.jpg',
      declaredMimeType: 'image/jpeg',
      declaredSize: JPEG_BYTES.byteLength,
      altText: 'Ein Ablauf in drei Schritten.',
      uploadedById: editor.userId,
    });
    const upload = `ws/ws-1/assets/${created.asset.id}/upload`;
    expect(media.storage.objects.get(upload)).toEqual({ bytes: JPEG_BYTES, contentType: 'image/jpeg' });
    expect(media.jobs.jobs).toEqual([
      { organizationId: editor.organizationId, workspaceId: 'ws-1', assetId: created.asset.id },
    ]);
    expect(ai.estimates).toEqual([expect.objectContaining({ task: 'diagram' })]);
    expect(ai.generations).toEqual([
      expect.objectContaining({
        task: 'DIAGRAM',
        outcome: 'OK',
        input: { format: 'portrait', language: 'de', descriptionLength: 34 },
      }),
    ]);
  });

  it('stores nothing and records INVALID_OUTPUT when the renderer refuses the SVG', async () => {
    const { ai, media, renderer, create } = setup();
    renderer.reject = 'element script is not allowed';

    await expect(
      create.execute({ actor: editor, description: 'Ein Ablauf', format: 'square' }),
    ).rejects.toBeInstanceOf(DiagramRejectedError);

    expect(media.unitOfWork.state.assets.size).toBe(0);
    expect(media.jobs.jobs).toEqual([]);
    expect(ai.generations).toEqual([expect.objectContaining({ task: 'DIAGRAM', outcome: 'INVALID_OUTPUT' })]);
  });

  it('maps a failed call to AiCallFailedError and renders nothing', async () => {
    const { ai, renderer, create } = setup();
    ai.provider.diagram = () =>
      Promise.resolve({ ok: false, failure: failureOf('REFUSED'), report: reportOf() });

    await expect(
      create.execute({ actor: editor, description: 'Ein Ablauf', format: 'landscape' }),
    ).rejects.toBeInstanceOf(AiCallFailedError);
    expect(renderer.calls).toEqual([]);
  });

  it('refuses before the call when the storage of the plan is used up', async () => {
    const { ai, create } = setup(0);

    await expect(
      create.execute({ actor: editor, description: 'Ein Ablauf', format: 'square' }),
    ).rejects.toBeInstanceOf(StorageQuotaExceededError);
    expect(ai.provider.calls).toEqual([]);
  });

  it('lets viewers draw nothing', async () => {
    const { create } = setup();

    await expect(
      create.execute({ actor: actorOf('VIEWER'), description: 'Ein Ablauf', format: 'square' }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});

describe('diagramFileName', () => {
  it('makes a plain file name from the title', () => {
    expect(diagramFileName('Größe & Wachstum 2026!')).toBe('grosse-wachstum-2026.jpg');
    expect(diagramFileName('???')).toBe('diagram.jpg');
  });
});
