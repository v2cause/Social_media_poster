import { describe, expect, it } from 'vitest';

import {
  AiCallFailedError,
  CreateBrandVoice,
  CreatePost,
  GenerateIdeas,
  NotPermittedError,
  RefineVariant,
  SAMPLE_BRIEFS,
  TestBrandVoice,
  VariantNotFoundError,
  type GenerationEvent,
} from '../../src';
import { createAiTestbed, failureOf, reportOf, type AiTestbed } from '../in-memory-ai';
import { actorOf } from '../in-memory-content';

const editor = actorOf('EDITOR');
const admin = actorOf('ADMIN');

async function collect(events: AsyncIterable<GenerationEvent>): Promise<GenerationEvent[]> {
  const all: GenerationEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

async function variantIn(testbed: AiTestbed): Promise<string> {
  const { postId } = await new CreatePost(testbed).execute({
    actor: editor,
    brief: 'Neues Büro',
    language: 'de',
    styleId: null,
    brandVoiceId: null,
    ideaId: null,
    platforms: ['X'],
  });
  const variant = [...testbed.unitOfWork.state.variants.values()].find(
    (candidate) => candidate.postId === postId,
  );
  if (!variant) {
    throw new Error('missing variant');
  }
  return variant.id;
}

const current = { text: 'Wir ziehen um. Mehr dazu bald.', hashtags: ['Koeln'], firstComment: null };

describe('RefineVariant', () => {
  it('refines the text the editor shows and books the call', async () => {
    const testbed = createAiTestbed();
    const variantId = await variantIn(testbed);

    const events = await collect(
      new RefineVariant(testbed.deps).execute({
        actor: editor,
        variantId,
        action: 'translate',
        instruction: 'ignored for this action',
        language: 'en',
        current,
      }),
    );

    expect(events.map((event) => event.type)).toEqual(['generation.started', 'generation.completed']);
    expect(events.at(-1)).toMatchObject({
      variants: [{ variantId, targetKey: 't1', platform: 'X', text: 'Kurz.', count: { max: 280 } }],
    });
    expect(testbed.provider.calls[0]).toMatchObject({
      method: 'refineVariant',
      effort: 'low',
      input: { action: 'translate', language: 'en', instruction: null, variant: current },
    });
    expect(testbed.generations[0]).toMatchObject({ task: 'REFINE', outcome: 'OK' });
  });

  it('passes the instruction of a custom action and keeps the post language otherwise', async () => {
    const testbed = createAiTestbed();
    const variantId = await variantIn(testbed);

    await collect(
      new RefineVariant(testbed.deps).execute({
        actor: editor,
        variantId,
        action: 'custom',
        instruction: 'Mit Bezug zum Standort',
        language: 'en',
        current,
      }),
    );

    expect(testbed.provider.calls[0]?.input).toMatchObject({
      language: 'de',
      instruction: 'Mit Bezug zum Standort',
    });
  });

  it('refuses unknown variants before the stream', async () => {
    const testbed = createAiTestbed();

    await expect(
      collect(
        new RefineVariant(testbed.deps).execute({
          actor: editor,
          variantId: 'variant-unknown',
          action: 'shorter',
          instruction: null,
          language: null,
          current,
        }),
      ),
    ).rejects.toBeInstanceOf(VariantNotFoundError);
  });
});

describe('GenerateIdeas', () => {
  it('stores new ideas once, without the ones that resemble existing ideas', async () => {
    const testbed = createAiTestbed();
    testbed.unitOfWork.state.ideas.set('idea-old', {
      id: 'idea-old',
      workspaceId: 'ws-1',
      title: 'Idee 2',
      angle: null,
      pillar: null,
      whyNow: null,
      basedOn: [],
      suggestedPlatforms: [],
      suggestedStyleKey: null,
      format: null,
      status: 'DISCARDED',
      source: 'AI',
      aiGenerationId: null,
      createdById: null,
      version: 0,
    });
    testbed.unitOfWork.state.languages.set('ws-1', 'en');

    const result = await new GenerateIdeas(testbed.deps).execute({ actor: editor, count: 3 });

    expect(result.duplicates).toBe(1);
    expect(result.ideaIds.map((id) => testbed.unitOfWork.state.ideas.get(id)?.title)).toEqual([
      'Idee 1',
      'Idee 3',
    ]);
    expect(testbed.unitOfWork.state.ideas.get(result.ideaIds[0] ?? '')).toMatchObject({
      status: 'NEW',
      source: 'AI',
      aiGenerationId: testbed.generations[0]?.id,
      createdById: editor.userId,
    });
    expect(testbed.provider.calls[0]?.input).toMatchObject({
      language: 'en',
      count: 3,
      discardedIdeas: ['Idee 2'],
    });
    expect(testbed.generations[0]).toMatchObject({ task: 'IDEAS', outcome: 'OK', costMicros: 24_000n });
  });

  it('builds on the top performers of 90 days and points the ideas at their posts', async () => {
    const first = '0190a6a2-6c5e-7d3f-8a1b-2c3d4e5f6a7b';
    const second = '0190a6a2-6c5e-7d3f-8a1b-2c3d4e5f6a7c';
    const testbed = createAiTestbed();
    testbed.unitOfWork.state.topPerformers.set('ws-1', [
      {
        variantId: first,
        platform: 'LINKEDIN',
        text: 'Drei Fehler, die Reichweite kosten',
        publishedOn: '2026-10-01',
        impressions: 2_000,
        views: null,
        reach: 1_500,
        engagements: 120,
      },
      {
        variantId: second,
        platform: 'INSTAGRAM',
        text: 'Ein Blick hinter die Kulissen',
        publishedOn: '2026-09-20',
        impressions: null,
        views: 800,
        reach: null,
        engagements: 64,
      },
    ]);
    const idea = {
      angle: 'Ein Blickwinkel',
      pillar: null,
      whyNow: 'Jetzt',
      suggestedPlatforms: ['LINKEDIN' as const],
      suggestedStyleKey: null,
      format: 'Textbeitrag',
    };
    testbed.provider.topics = () =>
      Promise.resolve({
        ok: true,
        value: [
          { ...idea, title: 'Noch mehr Fehler', basedOn: ['top-1', 'Content-Säule'] },
          { ...idea, title: 'Mehr Einblicke', basedOn: ['Top 2', 'top-1', 'top-9', ' '] },
        ],
        report: reportOf(),
      });

    const result = await new GenerateIdeas(testbed.deps).execute({ actor: editor, count: 2 });

    // The last 90 days before now, the five best seen at least 100 times.
    expect(testbed.unitOfWork.topPerformerQueries).toEqual([
      { since: new Date('2026-07-18T12:00:00Z'), limit: 5, minImpressions: 100 },
    ]);
    expect(testbed.provider.calls[0]?.input).toMatchObject({
      topPosts: [
        {
          ref: 'top-1',
          platform: 'LINKEDIN',
          text: 'Drei Fehler, die Reichweite kosten',
          publishedOn: '2026-10-01',
          impressions: 2_000,
          engagements: 120,
          engagementRate: 0.06,
        },
        { ref: 'top-2', platform: 'INSTAGRAM', impressions: null, engagements: 64, engagementRate: 0.08 },
      ],
    });
    // A ref becomes its post, a ref without a post goes, everything else stays.
    expect(result.ideaIds.map((id) => testbed.unitOfWork.state.ideas.get(id)?.basedOn)).toEqual([
      [`variant:${first}`, 'Content-Säule'],
      [`variant:${second}`, `variant:${first}`],
    ]);
    expect(testbed.generations[0]?.input).toMatchObject({ topPosts: [first, second] });
  });

  it('answers a refusal with a domain error and books the attempt', async () => {
    const testbed = createAiTestbed();
    testbed.provider.topics = () =>
      Promise.resolve({
        ok: false,
        failure: failureOf('REFUSED'),
        report: reportOf({ stopReason: 'refusal' }),
      });

    const failed = new GenerateIdeas(testbed.deps).execute({ actor: editor, count: 10 });

    await expect(failed).rejects.toBeInstanceOf(AiCallFailedError);
    await expect(failed).rejects.toMatchObject({ code: 'AI_REFUSED', kind: 'invalid' });
    expect(testbed.generations[0]).toMatchObject({ outcome: 'REFUSED', costMicros: 24_000n });
    expect(testbed.unitOfWork.state.ideas.size).toBe(0);
  });

  it('records an unexpected error as a provider error', async () => {
    const testbed = createAiTestbed();
    testbed.provider.topics = () => Promise.reject(new TypeError('socket hang up'));

    await expect(
      new GenerateIdeas(testbed.deps).execute({ actor: editor, count: 10 }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(testbed.generations[0]).toMatchObject({ outcome: 'PROVIDER_ERROR', report: null, costMicros: 0n });
  });
});

describe('TestBrandVoice', () => {
  it('writes a sample post in the voice and its language', async () => {
    const testbed = createAiTestbed();
    const { brandVoiceId } = await new CreateBrandVoice(testbed).execute({
      actor: admin,
      content: {
        name: 'Acme',
        description: '',
        tone: [],
        dos: [],
        donts: [],
        vocabulary: [],
        forbiddenWords: [],
        emojiPolicy: 'none',
        hashtagPolicy: 'few',
        examplePosts: [],
        language: 'en',
      },
      isDefault: false,
    });

    const result = await new TestBrandVoice(testbed.deps).execute({
      actor: admin,
      brandVoiceId,
      brief: null,
    });

    expect(result).toMatchObject({
      generationId: testbed.generations[0]?.id,
      variant: { platform: 'LINKEDIN', text: 'Hallo LINKEDIN.', count: { overLimit: false } },
    });
    expect(result.variant).not.toHaveProperty('variantId');
    expect(testbed.provider.calls[0]?.input).toMatchObject({ language: 'en', brief: SAMPLE_BRIEFS.en });
    expect(testbed.generations[0]).toMatchObject({ task: 'VOICE_TEST', postId: null });
  });

  it('is for owners and admins only', async () => {
    const testbed = createAiTestbed();

    await expect(
      new TestBrandVoice(testbed.deps).execute({ actor: editor, brandVoiceId: 'voice-1', brief: null }),
    ).rejects.toBeInstanceOf(NotPermittedError);
  });
});
