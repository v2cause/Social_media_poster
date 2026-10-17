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

  it('ranks the top performers of a period by engagements, without dry runs and deleted posts', async () => {
    const system = await (database as TestDatabase).connectAs('app_system');
    const connection = randomUUID();
    const account = randomUUID();
    const postId = randomUUID();
    const ids: Record<string, string> = {};
    try {
      await system.query(
        `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name, updated_at)
         VALUES ($1, $2, 'LINKEDIN', 'MOCK', 'top-user', 'Top', now())`,
        [connection, workspaceA],
      );
      await system.query(
        `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name, updated_at)
         VALUES ($1, $2, $3, 'LINKEDIN', 'PAGE', 'top-page', 'Top', now())`,
        [account, workspaceA, connection],
      );
      await system.query(
        `INSERT INTO post (id, workspace_id, language, updated_at) VALUES ($1, $2, 'de', now())`,
        [postId, workspaceA],
      );
      const variants: [
        string,
        string,
        string,
        string,
        number | null,
        number | null,
        number | null,
        string,
      ][] = [
        // key, platform, text, published, impressions, views, engagements, kind
        ['t1', 'LINKEDIN', 'Erfolg auf LinkedIn', '2026-10-01T22:30:00Z', 1_000, null, 90, 'published'],
        ['t2', 'X', 'Erfolg auf X', '2026-09-20T08:00:00Z', null, 500, 120, 'published'],
        ['t3', 'INSTAGRAM', 'Kaum gesehen', '2026-10-02T08:00:00Z', 50, null, 500, 'published'],
        ['t4', 'FACEBOOK', 'Zu alt', '2026-04-01T08:00:00Z', 5_000, null, 900, 'published'],
        ['t5', 'LINKEDIN', 'Extern geloescht', '2026-10-03T08:00:00Z', 5_000, null, 800, 'deleted'],
        ['t6', 'LINKEDIN', 'Probelauf', '2026-10-04T08:00:00Z', 5_000, null, 700, 'dry_run'],
        ['t7', 'LINKEDIN', 'Ohne Zahlen', '2026-10-05T08:00:00Z', 5_000, null, null, 'published'],
      ];
      for (const [key, platform, text, publishedAt, impressions, views, engagements, kind] of variants) {
        const id = randomUUID();
        ids[key] = id;
        await system.query(
          `INSERT INTO post_variant (id, workspace_id, post_id, platform, target_key, social_account_id, text, status,
                                     published_at, is_dry_run, external_deleted_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'PUBLISHED', $8, $9, $10, now())`,
          [
            id,
            workspaceA,
            postId,
            platform,
            key,
            account,
            text,
            publishedAt,
            kind === 'dry_run',
            kind === 'deleted' ? publishedAt : null,
          ],
        );
        await system.query(
          `INSERT INTO post_metric_latest (variant_id, workspace_id, social_account_id, platform, published_at,
                                           captured_at, impressions, views, engagements, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5, $6, $7, $8, now())`,
          [id, workspaceA, account, platform, publishedAt, impressions, views, engagements],
        );
      }
    } finally {
      await system.end();
    }
    const unitOfWork = deps().unitOfWork;
    const query = { since: new Date('2026-07-19T00:00:00Z'), limit: 5, minImpressions: 100 };
    const top = await unitOfWork.run(
      { userId: editor.userId, organizationId: orgA, workspaceId: workspaceA },
      (store) => store.posts.topPerformers(workspaceA, query),
    );

    // Views count where X has no impressions; the local day follows the time zone of the workspace.
    expect(top).toEqual([
      {
        variantId: ids['t2'],
        platform: 'X',
        text: 'Erfolg auf X',
        publishedOn: '2026-09-20',
        impressions: null,
        views: 500,
        reach: null,
        engagements: 120,
      },
      {
        variantId: ids['t1'],
        platform: 'LINKEDIN',
        text: 'Erfolg auf LinkedIn',
        publishedOn: '2026-10-02',
        impressions: 1_000,
        views: null,
        reach: null,
        engagements: 90,
      },
    ]);
    const first = await unitOfWork.run(
      { userId: editor.userId, organizationId: orgA, workspaceId: workspaceA },
      (store) => store.posts.topPerformers(workspaceA, { ...query, limit: 1 }),
    );
    expect(first.map((post) => post.variantId)).toEqual([ids['t2']]);
    const otherWorkspace = await unitOfWork.run(
      { userId: editor.userId, organizationId: orgB, workspaceId: workspaceB },
      (store) => store.posts.topPerformers(workspaceB, query),
    );
    expect(otherWorkspace).toEqual([]);
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
