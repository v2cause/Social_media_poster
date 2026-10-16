import { randomUUID } from 'node:crypto';

import {
  CreateBrandVoice,
  CreatePost,
  CreateStyle,
  PostNotFoundError,
  PresetStyleError,
  StyleNameTakenError,
  systemClock,
  UpdateBrandVoice,
  UpdatePost,
  UpdateStyle,
  UpdateVariant,
  uuidV7Ids,
  VersionConflictError,
  type BrandVoiceContent,
  type ContentActor,
  type ContentDependencies,
} from '@smp/core';
import { startTestDatabase, type TestDatabase } from '@smp/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContentReadModel,
  createPrismaClient,
  PrismaAiGenerationLog,
  PrismaContentUnitOfWork,
  type PrismaClient,
} from '../src';

// The Prisma adapters of the content ports against PostgreSQL with row-level security: the use
// cases of the core run unchanged, every workspace sees only its own content, and the read model
// shows what the composer and the settings pages need.

const orgA = randomUUID();
const orgB = randomUUID();
const workspaceA = randomUUID();
const workspaceB = randomUUID();

const actor = (role: ContentActor['role'], workspaceId = workspaceA): ContentActor => ({
  userId: randomUUID(),
  organizationId: workspaceId === workspaceA ? orgA : orgB,
  workspaceId,
  role,
});
const editor = actor('EDITOR');
const admin = actor('ADMIN');
const refA = { organizationId: orgA, workspaceId: workspaceA };

const voiceContent = (overrides: Partial<BrandVoiceContent> = {}): BrandVoiceContent => ({
  name: 'Acme',
  description: 'Klar und freundlich.',
  tone: ['klar', 'warm'],
  dos: ['Konkrete Beispiele'],
  donts: ['Fachchinesisch'],
  vocabulary: [],
  forbiddenWords: ['Synergie'],
  emojiPolicy: 'none',
  hashtagPolicy: 'few',
  examplePosts: ['Ein Beispiel.'],
  language: 'de',
  ...overrides,
});

describe('content adapters on PostgreSQL', () => {
  let database: TestDatabase | undefined;
  let base: PrismaClient | undefined;

  const client = (): PrismaClient => {
    if (!base) {
      throw new Error('database not ready');
    }
    return base;
  };
  const deps = (): ContentDependencies => ({
    unitOfWork: new PrismaContentUnitOfWork(client(), () => ({
      ipAddress: '192.0.2.1',
      userAgent: 'vitest',
    })),
    clock: systemClock,
    ids: uuidV7Ids,
  });
  const readModel = (): ContentReadModel => new ContentReadModel(client());

  beforeAll(async () => {
    database = await startTestDatabase();
    const system = await database.connectAs('app_system');
    try {
      await system.query(
        `INSERT INTO organization (id, name, updated_at) VALUES ($1, 'A', now()), ($2, 'B', now())`,
        [orgA, orgB],
      );
      await system.query(
        `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
         VALUES ($1, $2, 'content-adapters-a', 'A', 'Europe/Berlin', 'de', now()),
                ($3, $4, 'content-adapters-b', 'B', 'Europe/Berlin', 'en', now())`,
        [workspaceA, orgA, workspaceB, orgB],
      );
    } finally {
      await system.end();
    }
    base = createPrismaClient(database.url('app_user'));
  }, 300_000);

  afterAll(async () => {
    await base?.$disconnect();
    await database?.stop();
  });

  it('creates and changes posts with their variants, with optimistic locking', async () => {
    const styles = await readModel().styles(refA);
    const professional = styles.find((style) => style.key === 'professional');
    const { postId } = await new CreatePost(deps()).execute({
      actor: editor,
      brief: 'Neues Büro in Köln',
      language: 'de',
      styleId: professional?.id ?? null,
      brandVoiceId: null,
      ideaId: null,
      platforms: ['LINKEDIN', 'X'],
    });

    const created = await readModel().post(refA, postId);
    expect(created).toMatchObject({ brief: 'Neues Büro in Köln', language: 'de', version: 0 });
    expect(created?.variants.map((variant) => [variant.targetKey, variant.platform, variant.status])).toEqual(
      [
        ['t1', 'LINKEDIN', 'DRAFT'],
        ['t2', 'X', 'DRAFT'],
      ],
    );

    await new UpdatePost(deps()).execute({
      actor: editor,
      postId,
      version: 0,
      patch: { brief: 'Neues Büro in Köln, Eröffnung am Freitag' },
      platforms: ['X', 'INSTAGRAM'],
    });
    const linkedinGone = await readModel().post(refA, postId);
    expect(linkedinGone?.version).toBe(1);
    expect(linkedinGone?.variants.map((variant) => [variant.targetKey, variant.platform])).toEqual([
      ['t1', 'INSTAGRAM'],
      ['t2', 'X'],
    ]);

    const x = linkedinGone?.variants.find((variant) => variant.platform === 'X');
    if (!x) {
      throw new Error('missing variant');
    }
    const update = new UpdateVariant(deps());
    await update.execute({
      actor: editor,
      variantId: x.id,
      version: 0,
      patch: { text: 'Wir ziehen um.', hashtags: ['Koeln'], firstComment: null },
    });
    await expect(
      update.execute({ actor: editor, variantId: x.id, version: 0, patch: { text: 'Zu spät' } }),
    ).rejects.toBeInstanceOf(VersionConflictError);
    expect(await readModel().variant(refA, x.id)).toMatchObject({
      text: 'Wir ziehen um.',
      hashtags: ['Koeln'],
      version: 1,
    });
  });

  it('keeps the content of a workspace invisible to every other workspace', async () => {
    const { postId } = await new CreatePost(deps()).execute({
      actor: editor,
      brief: 'Nur für A',
      language: 'de',
      styleId: null,
      brandVoiceId: null,
      ideaId: null,
      platforms: ['FACEBOOK'],
    });
    const outsider = actor('OWNER', workspaceB);

    await expect(
      new UpdatePost(deps()).execute({ actor: outsider, postId, version: 0, patch: { brief: 'B war hier' } }),
    ).rejects.toBeInstanceOf(PostNotFoundError);
    expect(await readModel().post({ organizationId: orgB, workspaceId: workspaceB }, postId)).toBeNull();
    expect(
      (await readModel().listPosts({ organizationId: orgB, workspaceId: workspaceB }, { limit: 10 })).posts,
    ).toEqual([]);
  });

  it('pages through the posts, recently changed first', async () => {
    const first = await readModel().listPosts(refA, { limit: 1 });
    expect(first.posts).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = await readModel().listPosts(refA, { limit: 1, cursor: first.nextCursor ?? undefined });
    expect(second.posts).toHaveLength(1);
    expect(second.posts[0]?.id).not.toBe(first.posts[0]?.id);
    expect(second.posts[0]?.variants[0]).toMatchObject({ status: 'DRAFT' });
  });

  it('lists the presets first and manages custom styles of the workspace', async () => {
    const create = new CreateStyle(deps());
    const { styleId } = await create.execute({
      actor: admin,
      name: 'Kurz & herzlich',
      instructions: 'Kurz.',
    });
    await expect(
      create.execute({ actor: admin, name: 'kurz herzlich', instructions: 'x' }),
    ).rejects.toBeInstanceOf(StyleNameTakenError);
    await new UpdateStyle(deps()).execute({ actor: admin, styleId, version: 0, patch: { isActive: false } });

    const styles = await readModel().styles(refA);
    expect(styles.slice(0, 6).every((style) => style.isPreset)).toBe(true);
    expect(styles.at(-1)).toMatchObject({
      key: 'custom-kurz-herzlich',
      isPreset: false,
      isActive: false,
      version: 1,
    });
    await expect(
      new UpdateStyle(deps()).execute({
        actor: admin,
        styleId: styles[0]?.id ?? '',
        version: 0,
        patch: { name: 'Mein Preset' },
      }),
    ).rejects.toBeInstanceOf(PresetStyleError);
    expect(
      (await readModel().styles({ organizationId: orgB, workspaceId: workspaceB })).map((s) => s.key),
    ).not.toContain('custom-kurz-herzlich');
  });

  it('keeps every content change of a brand voice as an immutable version', async () => {
    const { brandVoiceId } = await new CreateBrandVoice(deps()).execute({
      actor: admin,
      content: voiceContent(),
      isDefault: false,
    });
    await new UpdateBrandVoice(deps()).execute({
      actor: admin,
      brandVoiceId,
      version: 0,
      content: voiceContent({ name: 'Acme Neu', tone: ['nahbar'] }),
    });

    const [voice] = await readModel().brandVoices(refA, { includeArchived: true });
    expect(voice).toMatchObject({
      id: brandVoiceId,
      name: 'Acme Neu',
      isDefault: true,
      currentVersionNumber: 2,
      content: { tone: ['nahbar'] },
    });
    const versions = await readModel().brandVoiceVersions(refA, brandVoiceId);
    expect(versions?.map((version) => [version.versionNumber, version.content.name])).toEqual([
      [2, 'Acme Neu'],
      [1, 'Acme'],
    ]);
    expect(
      await readModel().brandVoiceVersions({ organizationId: orgB, workspaceId: workspaceB }, brandVoiceId),
    ).toBeNull();
  });

  it('writes an AiGeneration with the sums over all attempts, readable only in its workspace', async () => {
    const id = uuidV7Ids.newId();
    await new PrismaAiGenerationLog(client()).record({
      id,
      organizationId: orgA,
      workspaceId: workspaceA,
      userId: editor.userId,
      task: 'GENERATE',
      postId: null,
      brandVoiceVersionId: null,
      report: {
        provider: 'mock',
        promptVersion: 'gen-v1',
        modelRequested: 'claude-opus-5-5',
        modelServed: 'claude-opus-5',
        effort: 'medium',
        attempts: [
          {
            kind: 'message',
            model: 'claude-opus-5-5',
            inputTokens: 100,
            outputTokens: 10,
            cacheReadTokens: 1000,
            cacheWrite5mTokens: 5,
            cacheWrite1hTokens: 0,
          },
          {
            kind: 'fallback_message',
            model: 'claude-opus-5',
            inputTokens: 100,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 7,
          },
        ],
        stopReason: 'end_turn',
        refusalCategory: null,
        ttftMs: 120,
        latencyMs: 2400,
      },
      provider: 'mock',
      promptVersion: 'gen-v1',
      modelRequested: 'claude-opus-5-5',
      effort: 'medium',
      input: { brief: 'Neues Büro', skipped: undefined },
      output: [{ targetKey: 't1' }],
      outcome: 'OK',
      costMicros: 12_345n,
    });

    const system = await (database as TestDatabase).connectAs('app_system');
    try {
      const { rows } = await system.query(
        `SELECT model_served, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
                cost_micros::text, input, jsonb_array_length(attempts) AS attempts, latency_ms, ttft_ms
           FROM ai_generation WHERE id = $1`,
        [id],
      );
      expect(rows).toEqual([
        {
          model_served: 'claude-opus-5',
          input_tokens: 200,
          output_tokens: 210,
          cache_read_tokens: 1000,
          cache_write_tokens: 12,
          cost_micros: '12345',
          input: { brief: 'Neues Büro' },
          attempts: 2,
          latency_ms: 2400,
          ttft_ms: 120,
        },
      ]);
    } finally {
      await system.end();
    }
  });

  it('finds near-duplicate idea titles with pg_trgm', async () => {
    const unitOfWork = deps().unitOfWork;
    const scope = { userId: editor.userId, organizationId: orgA, workspaceId: workspaceA };
    await unitOfWork.run(scope, (store) =>
      store.ideas.insertMany([
        {
          id: uuidV7Ids.newId(),
          workspaceId: workspaceA,
          title: 'Drei Fragen, die uns Kunden am häufigsten stellen',
          angle: null,
          pillar: null,
          whyNow: null,
          basedOn: [],
          suggestedPlatforms: ['LINKEDIN'],
          suggestedStyleKey: 'educational',
          format: null,
          status: 'DISCARDED',
          source: 'AI',
          aiGenerationId: null,
          createdById: editor.userId,
          version: 0,
        },
      ]),
    );

    const similar = await unitOfWork.run(scope, (store) =>
      store.ideas.similarTitles(workspaceA, [
        'Drei Fragen, die Kunden uns am häufigsten stellen',
        'Ein Blick hinter die Kulissen',
      ]),
    );
    const discarded = await unitOfWork.run(scope, (store) =>
      store.ideas.recentTitles(workspaceA, 'DISCARDED', 5),
    );
    const otherWorkspace = await unitOfWork.run(
      { userId: editor.userId, organizationId: orgB, workspaceId: workspaceB },
      (store) => store.ideas.similarTitles(workspaceB, ['Drei Fragen, die uns Kunden am häufigsten stellen']),
    );

    expect(similar).toEqual(['Drei Fragen, die Kunden uns am häufigsten stellen']);
    expect(discarded).toEqual(['Drei Fragen, die uns Kunden am häufigsten stellen']);
    expect(otherWorkspace).toEqual([]);
  });
});
