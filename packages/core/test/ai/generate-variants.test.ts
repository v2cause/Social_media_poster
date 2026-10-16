import { describe, expect, it } from 'vitest';

import {
  BriefRequiredError,
  CreatePost,
  GenerateVariants,
  NotPermittedError,
  PostNotFoundError,
  QuotaExceededError,
  type GenerationEvent,
  type GeneratedVariantResult,
} from '../../src';
import { createAiTestbed, failureOf, reportOf, streamOf, variantFor, type AiTestbed } from '../in-memory-ai';
import { actorOf } from '../in-memory-content';

const editor = actorOf('EDITOR');

async function postIn(testbed: AiTestbed, brief = 'Neues Büro in Köln') {
  const { postId } = await new CreatePost(testbed).execute({
    actor: editor,
    brief,
    language: 'de',
    styleId: null,
    brandVoiceId: null,
    ideaId: null,
    platforms: ['LINKEDIN', 'X'],
  });
  return postId;
}

async function collect(events: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const all: GenerationEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

const completedOf = (events: GenerationEvent[]): GeneratedVariantResult[] => {
  const last = events.at(-1);
  if (last?.type !== 'generation.completed') {
    throw new Error(`expected generation.completed, got ${String(last?.type)}`);
  }
  return last.variants;
};

describe('GenerateVariants', () => {
  it('streams the variants, checks them and books the call', async () => {
    const testbed = createAiTestbed();
    const postId = await postIn(testbed);

    const events = await collect(new GenerateVariants(testbed.deps).execute({ actor: editor, postId }));

    expect(events.map((event) => event.type)).toEqual([
      'generation.started',
      'variant.partial',
      'generation.completed',
    ]);
    const variants = completedOf(events);
    const stored = [...testbed.unitOfWork.state.variants.values()];
    expect(variants.map((variant) => [variant.targetKey, variant.platform, variant.text])).toEqual([
      ['t1', 'LINKEDIN', 'Hallo LINKEDIN.'],
      ['t2', 'X', 'Hallo X.'],
    ]);
    expect(variants.map((variant) => variant.variantId)).toEqual(stored.map((variant) => variant.id));
    expect(variants[1]).toMatchObject({
      count: { length: 8, max: 280, overLimit: false },
      issues: [],
      autoShortened: false,
    });

    // The prompt got the brief, the default style and the targets; the effort of the route.
    expect(testbed.provider.calls).toHaveLength(1);
    expect(testbed.provider.calls[0]).toMatchObject({
      method: 'generateVariants',
      effort: 'medium',
      input: {
        brief: 'Neues Büro in Köln',
        styleKey: 'professional',
        targets: [
          { key: 't1', platform: 'LINKEDIN' },
          { key: 't2', platform: 'X' },
        ],
      },
    });
    // Reserved 100000, booked the actual 24000 micro-USD.
    expect(testbed.quotaStore.total()).toBe(24_000n);
    expect(testbed.generations).toEqual([
      expect.objectContaining({
        task: 'GENERATE',
        postId,
        outcome: 'OK',
        costMicros: 24_000n,
        effort: 'medium',
        userId: editor.userId,
      }),
    ]);
    expect(testbed.quotaStore.ledger).toEqual([
      expect.objectContaining({
        sourceType: 'ai_generation',
        sourceId: testbed.generations[0]?.id,
        quantity: 24_000n,
      }),
    ]);
  });

  it('fails before the stream when the post is missing, has no brief or the quota is used up', async () => {
    const testbed = createAiTestbed({ limit: 99_999n });
    const generate = new GenerateVariants(testbed.deps);
    const empty = await postIn(testbed, '   ');
    const postId = await postIn(testbed);

    await expect(collect(generate.execute({ actor: editor, postId: 'post-unknown' }))).rejects.toBeInstanceOf(
      PostNotFoundError,
    );
    await expect(collect(generate.execute({ actor: editor, postId: empty }))).rejects.toBeInstanceOf(
      BriefRequiredError,
    );
    await expect(collect(generate.execute({ actor: editor, postId }))).rejects.toBeInstanceOf(
      QuotaExceededError,
    );
    await expect(collect(generate.execute({ actor: actorOf('VIEWER'), postId }))).rejects.toBeInstanceOf(
      NotPermittedError,
    );
    expect(testbed.provider.calls).toEqual([]);
    expect(testbed.generations).toEqual([]);
    expect(testbed.quotaStore.total()).toBe(0n);
  });

  it('sends a refusal as generation.failed and books what the attempt cost', async () => {
    const testbed = createAiTestbed();
    const postId = await postIn(testbed);
    testbed.provider.generate = () =>
      streamOf([
        { type: 'failed', failure: failureOf('REFUSED'), report: reportOf({ stopReason: 'refusal' }) },
      ]);

    const events = await collect(new GenerateVariants(testbed.deps).execute({ actor: editor, postId }));

    expect(events.at(-1)).toEqual({
      type: 'generation.failed',
      generationId: testbed.generations[0]?.id,
      code: 'REFUSED',
      retryable: false,
    });
    expect(testbed.generations[0]).toMatchObject({ outcome: 'REFUSED', output: null, costMicros: 24_000n });
    expect(testbed.quotaStore.total()).toBe(24_000n);
  });

  it('books a call the client left after the start as canceled, without cost', async () => {
    const testbed = createAiTestbed();
    const postId = await postIn(testbed);
    const events = new GenerateVariants(testbed.deps).execute({ actor: editor, postId });

    const first = await events.next();
    await events.return(undefined);

    expect(first.value).toMatchObject({ type: 'generation.started' });
    expect(testbed.generations).toEqual([
      expect.objectContaining({ outcome: 'CANCELED', report: null, costMicros: 0n }),
    ]);
    expect(testbed.quotaStore.total()).toBe(0n);
  });

  it('turns an unexpected error of the provider into generation.failed', async () => {
    const testbed = createAiTestbed();
    const postId = await postIn(testbed);
    testbed.provider.generate = () => streamOf([{ type: 'reset' }], new TypeError('socket hang up'));

    const events = await collect(new GenerateVariants(testbed.deps).execute({ actor: editor, postId }));

    expect(events.map((event) => event.type)).toEqual([
      'generation.started',
      'variant.reset',
      'generation.failed',
    ]);
    expect(events.at(-1)).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(testbed.generations[0]).toMatchObject({ outcome: 'PROVIDER_ERROR' });
    expect(testbed.warnings).toEqual(['ai.generation_error']);
  });

  it('shortens a variant over the limit once and books the refinement on its own', async () => {
    const testbed = createAiTestbed();
    const postId = await postIn(testbed);
    testbed.provider.generate = (input) =>
      streamOf([
        {
          type: 'completed',
          variants: input.targets.map((target) => variantFor(target, 'Sehr lang. '.repeat(40).trim())),
          report: reportOf(),
        },
      ]);

    const variants = completedOf(
      await collect(new GenerateVariants(testbed.deps).execute({ actor: editor, postId })),
    );

    const [linkedin, x] = variants;
    expect(linkedin).toMatchObject({ autoShortened: false, count: { overLimit: false } });
    expect(x).toMatchObject({ text: 'Kurz.', autoShortened: true, count: { overLimit: false } });
    expect(testbed.provider.calls.map((call) => [call.method, call.effort])).toEqual([
      ['generateVariants', 'medium'],
      ['refineVariant', 'low'],
    ]);
    expect(testbed.generations.map((entry) => [entry.task, entry.outcome])).toEqual([
      ['GENERATE', 'OK'],
      ['REFINE', 'OK'],
    ]);
    expect(testbed.quotaStore.total()).toBe(48_000n);
  });

  it('uses the effort the workspace set and flags forbidden words of the brand voice', async () => {
    const testbed = createAiTestbed();
    testbed.unitOfWork.state.efforts.set('ws-1', { generate: 'high' });
    testbed.unitOfWork.state.voices.set('voice-1', {
      id: 'voice-1',
      workspaceId: 'ws-1',
      name: 'Acme',
      currentVersionNumber: 1,
      isDefault: true,
      archivedAt: null,
      version: 0,
    });
    testbed.unitOfWork.state.versions.push({
      id: 'voice-1-v1',
      workspaceId: 'ws-1',
      brandVoiceId: 'voice-1',
      versionNumber: 1,
      content: {
        name: 'Acme',
        description: '',
        tone: [],
        dos: [],
        donts: [],
        vocabulary: [],
        forbiddenWords: ['hallo', 'Synergie'],
        emojiPolicy: 'none',
        hashtagPolicy: 'few',
        examplePosts: [],
        language: 'de',
      },
      createdById: null,
    });
    const { postId } = await new CreatePost(testbed).execute({
      actor: editor,
      brief: 'Neues Büro',
      language: 'de',
      styleId: null,
      brandVoiceId: 'voice-1',
      ideaId: null,
      platforms: ['LINKEDIN'],
    });

    const variants = completedOf(
      await collect(new GenerateVariants(testbed.deps).execute({ actor: editor, postId })),
    );

    expect(testbed.provider.calls[0]?.effort).toBe('high');
    expect(variants[0]?.forbiddenWords).toEqual(['hallo']);
    expect(testbed.generations[0]).toMatchObject({ brandVoiceVersionId: 'voice-1-v1', effort: 'high' });
  });
});
