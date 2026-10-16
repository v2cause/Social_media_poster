import type { AddressInfo } from 'node:net';

import { STYLE_PRESETS } from '@smp/ai';
import type { GenerationEvent, PostDto } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import type Redis from 'ioredis';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REDIS_CLIENT } from '../src/infrastructure/clients.module';
import { AiRateLimiter } from '../src/modules/content/ai-rate-limiter';
import { APP_ORIGIN, startApiTestApp, type ApiTestApp } from './support/api-app';
import { signIn, type Browser } from './support/browser';
import { parseSse, sseParser } from './support/sse';

// Guide step 2.7, "Fertig, wenn": the content and AI endpoints end to end, with the mock
// provider: composer flow with optimistic locking, generation and refinement as server-sent
// events, errors before the stream, quota, rate limits, abort by the client, styles, brand
// voices and ideas. The permission matrix of these routes is in permission-matrix.

const SEED_PASSWORD = 'seed-password-for-the-content-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}`;

const userOf = (role: string) => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo user with role ${role}`);
  }
  return user;
};

describe('content and AI API', () => {
  let api: ApiTestApp | undefined;
  let system: Client | undefined;
  let editor: Browser | undefined;
  let admin: Browser | undefined;
  let organizationId = '';

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };
  const as = (browser: Browser | undefined): Browser => {
    if (!browser) {
      throw new Error('not signed in');
    }
    return browser;
  };
  const sql = async <T>(text: string, params: unknown[] = []): Promise<T[]> => {
    if (!system) {
      throw new Error('no database connection');
    }
    return (await system.query(text, params)).rows as T[];
  };
  const generate = async (browser: Browser, body: object): Promise<GenerationEvent[]> => {
    const response = await browser
      .post(`${ws}/ai/generations`)
      .send(body)
      .buffer(true)
      .parse(sseParser)
      .expect(200)
      .expect('Content-Type', /text\/event-stream/)
      .expect('Cache-Control', 'no-cache, no-transform');
    return parseSse(response.body as string);
  };
  const createPost = async (brief: string, platforms = ['LINKEDIN', 'X']): Promise<PostDto> => {
    const response = await as(editor)
      .post(`${ws}/posts`)
      .send({ brief, language: 'de', platforms })
      .expect(201);
    return response.body as PostDto;
  };

  beforeAll(async () => {
    api = await startApiTestApp({
      aiRateLimits: { perUserPerMinute: 1000, concurrentPerUser: 10, perWorkspacePerHour: 1000 },
    });
    const seed = createPrismaClient(api.database.url('app_system'));
    try {
      organizationId = (await seedDemoData(seed, SEED_PASSWORD)).organizationId;
    } finally {
      await seed.$disconnect();
    }
    system = await api.database.connectAs('app_system');
    editor = await signIn(api, userOf('EDITOR').email, SEED_PASSWORD);
    admin = await signIn(api, userOf('ADMIN').email, SEED_PASSWORD);
  });

  afterAll(async () => {
    await system?.end();
    await api?.close();
  });

  it('runs the composer flow with optimistic locking', async () => {
    const styles = (await as(editor).get(`${ws}/styles`).expect(200)).body as {
      styles: { id: string; key: string }[];
    };
    const storytelling = styles.styles.find((style) => style.key === 'storytelling');
    const created = (
      await as(editor)
        .post(`${ws}/posts`)
        .send({
          brief: 'Neues Büro in Köln',
          language: 'de',
          styleId: storytelling?.id,
          platforms: ['LINKEDIN', 'X'],
        })
        .expect(201)
    ).body as PostDto;

    expect(created).toMatchObject({ brief: 'Neues Büro in Köln', styleId: storytelling?.id, version: 0 });
    expect(created.variants.map((variant) => [variant.targetKey, variant.platform, variant.status])).toEqual([
      ['t1', 'LINKEDIN', 'DRAFT'],
      ['t2', 'X', 'DRAFT'],
    ]);

    const updated = (
      await as(editor)
        .patch(`${ws}/posts/${created.id}`)
        .send({ version: 0, brief: 'Neues Büro in Köln!' })
        .expect(200)
    ).body as PostDto;
    expect(updated.version).toBe(1);
    const conflict = await as(editor)
      .patch(`${ws}/posts/${created.id}`)
      .send({ version: 0, brief: 'Alt' })
      .expect(409);
    expect(conflict.body).toMatchObject({ code: 'VERSION_CONFLICT' });

    const [linkedin] = created.variants;
    const saved = await as(editor)
      .patch(`${ws}/variants/${linkedin?.id ?? ''}`)
      .send({ version: 0, text: 'Wir ziehen um.', hashtags: ['#Koeln', 'Umzug'] })
      .expect(200);
    expect(saved.body).toMatchObject({ text: 'Wir ziehen um.', hashtags: ['Koeln', 'Umzug'], version: 1 });
    await as(editor)
      .patch(`${ws}/variants/${linkedin?.id ?? ''}`)
      .send({ version: 0, text: 'Zu spät' })
      .expect(409);

    const page = (await as(editor).get(`${ws}/posts?limit=1`).expect(200)).body as {
      posts: { id: string; variants: { excerpt: string }[] }[];
    };
    expect(page.posts[0]).toMatchObject({
      id: created.id,
      variants: [{ excerpt: 'Wir ziehen um.' }, { excerpt: '' }],
    });
  });

  it('streams a generation with the mock and books it', async () => {
    const post = await createPost('Wir eröffnen unser neues Büro in Köln.');

    const events = await generate(as(editor), { postId: post.id });

    expect(events[0]).toMatchObject({ type: 'generation.started' });
    expect(events.filter((event) => event.type === 'variant.partial').length).toBeGreaterThan(5);
    const completed = events.at(-1);
    if (completed?.type !== 'generation.completed') {
      throw new Error(`expected generation.completed, got ${String(completed?.type)}`);
    }
    expect(completed.variants.map((variant) => [variant.variantId, variant.platform])).toEqual(
      post.variants.map((variant) => [variant.id, variant.platform]),
    );
    expect(completed.variants[1]).toMatchObject({
      hook: 'Wir eröffnen unser neues Büro in Köln: Worauf es jetzt ankommt.',
      count: { max: 280, overLimit: false },
      forbiddenWords: [],
      autoShortened: false,
    });

    const [generation] = await sql<{
      id: string;
      task: string;
      outcome: string;
      provider: string;
      cost: string;
    }>(
      `SELECT id, task, outcome, provider, cost_micros::text AS cost FROM ai_generation WHERE post_id = $1`,
      [post.id],
    );
    expect(generation).toMatchObject({ task: 'GENERATE', outcome: 'OK', provider: 'mock' });
    expect(Number(generation?.cost)).toBeGreaterThan(0);
    expect(
      await sql(`SELECT quantity::text AS quantity FROM usage_record WHERE source_id = $1`, [generation?.id]),
    ).toEqual([{ quantity: generation?.cost }]);
  });

  it('refines the text the editor shows', async () => {
    const post = await createPost('Ein Thema.', ['LINKEDIN']);
    const text = 'Erster Absatz.\n\nZweiter Absatz.\n\nDritter Absatz.';

    const events = parseSse(
      (
        await as(editor)
          .post(`${ws}/ai/refinements`)
          .send({
            variantId: post.variants[0]?.id,
            action: 'shorter',
            current: { text, hashtags: [], firstComment: null },
          })
          .buffer(true)
          .parse(sseParser)
          .expect(200)
      ).body as string,
    );

    expect(events.at(-1)).toMatchObject({
      type: 'generation.completed',
      variants: [{ variantId: post.variants[0]?.id, text: 'Erster Absatz.\n\nDritter Absatz.' }],
    });
  });

  it('answers errors before the stream as problem documents', async () => {
    const empty = await createPost('');

    const missing = await as(editor)
      .post(`${ws}/ai/generations`)
      .send({ postId: '00000000-0000-4000-8000-000000000000' })
      .expect(404);
    expect(missing.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(missing.body).toMatchObject({ code: 'POST_NOT_FOUND' });
    await as(editor).post(`${ws}/ai/generations`).send({ postId: empty.id }).expect(422);
    const invalid = await as(editor)
      .post(`${ws}/ai/refinements`)
      .send({
        variantId: empty.variants[0]?.id,
        action: 'custom',
        current: { text: '', hashtags: [], firstComment: null },
      })
      .expect(400);
    expect(invalid.body).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('sends failures of the mock as generation.failed and books them', async () => {
    const post = await createPost('[mock:refusal] Ein heikles Thema.');

    const events = await generate(as(editor), { postId: post.id });

    expect(events.at(-1)).toMatchObject({ type: 'generation.failed', code: 'REFUSED', retryable: false });
    expect(await sql(`SELECT outcome FROM ai_generation WHERE post_id = $1`, [post.id])).toEqual([
      { outcome: 'REFUSED' },
    ]);
  });

  it('answers 402 when the quota of the month is used up', async () => {
    const post = await createPost('Noch ein Beitrag.');
    await sql(
      `INSERT INTO usage_counter (id, organization_id, meter, period_start, value, updated_at)
       VALUES (gen_random_uuid(), $1, 'ai_micros', date_trunc('month', now() AT TIME ZONE 'UTC')::date, 10000000, now())
       ON CONFLICT (organization_id, meter, period_start) DO UPDATE SET value = 10000000`,
      [organizationId],
    );
    try {
      const response = await as(editor).post(`${ws}/ai/generations`).send({ postId: post.id }).expect(402);
      expect(response.body).toMatchObject({ code: 'QUOTA_EXCEEDED' });
    } finally {
      await sql(`UPDATE usage_counter SET value = 0 WHERE organization_id = $1`, [organizationId]);
    }
  });

  it('aborts the AI call when the client goes away, and books it as canceled', async () => {
    const app = started();
    await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
    const headers = { 'Content-Type': 'application/json', Origin: APP_ORIGIN, 'X-Real-IP': '192.0.2.250' };
    const session = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email: userOf('EDITOR').email, password: SEED_PASSWORD }),
    });
    const cookie = session.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const post = await createPost('[mock:slow] Ein langsames Thema.');

    const controller = new AbortController();
    const response = await fetch(`${base}${ws}/ai/generations`, {
      method: 'POST',
      headers: { ...headers, Cookie: cookie },
      body: JSON.stringify({ postId: post.id }),
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    const first = await reader?.read();
    controller.abort();

    expect(new TextDecoder().decode(first?.value)).toContain('event: generation.started');
    let outcome: string | undefined;
    for (let attempt = 0; attempt < 50 && !outcome; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      outcome = (
        await sql<{ outcome: string }>(`SELECT outcome FROM ai_generation WHERE post_id = $1`, [post.id])
      )[0]?.outcome;
    }
    expect(outcome).toBe('CANCELED');
  });

  it('limits AI calls per user and minute and running calls per user', async () => {
    const redis = started().app.get<Redis>(REDIS_CLIENT);
    const limiter = new AiRateLimiter(redis, {
      perUserPerMinute: 2,
      concurrentPerUser: 1,
      perWorkspacePerHour: 100,
    });
    const actor = {
      userId: '00000000-0000-4000-8000-000000000001',
      organizationId,
      workspaceId: '00000000-0000-4000-8000-000000000002',
      role: 'EDITOR' as const,
    };

    const slot = await limiter.acquire(actor, 0);
    await expect(limiter.acquire(actor, 0)).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
    await slot.release();
    await (await limiter.acquire(actor, 60_000)).release();
    await expect(limiter.acquire(actor, 60_000)).resolves.toBeDefined();
    await expect(limiter.acquire(actor, 60_000)).rejects.toMatchObject({ code: 'AI_RATE_LIMITED' });
  });

  it('serves the style presets of the migration exactly as the prompt describes them', async () => {
    const styles = (await as(editor).get(`${ws}/styles`).expect(200)).body as {
      styles: { key: string; name: string; instructions: string; isPreset: boolean }[];
    };

    expect(
      styles.styles
        .filter((style) => style.isPreset)
        .map((style) => ({ key: style.key, name: style.name, instructions: style.instructions })),
    ).toEqual(STYLE_PRESETS.map((preset) => ({ ...preset })));
  });

  it('manages custom styles and brand voices with versions and a voice test', async () => {
    const style = await as(admin)
      .post(`${ws}/styles`)
      .send({ name: 'Kurz und herzlich', instructions: 'Kurze Sätze, warmer Ton.' })
      .expect(201);
    expect(style.body).toMatchObject({ key: 'custom-kurz-und-herzlich', isPreset: false, isActive: true });
    await as(admin).post(`${ws}/styles`).send({ name: 'Kurz und herzlich!', instructions: 'x' }).expect(409);

    const content = { name: 'Acme', tone: ['klar'], forbiddenWords: ['Synergie'], language: 'de' };
    const voice = await as(admin).post(`${ws}/brand-voices`).send({ content }).expect(201);
    expect(voice.body).toMatchObject({
      name: 'Acme',
      isDefault: true,
      currentVersionNumber: 1,
      content: { emojiPolicy: 'sparse', hashtagPolicy: 'few' },
    });
    const voiceId = (voice.body as { id: string }).id;
    await as(admin)
      .patch(`${ws}/brand-voices/${voiceId}`)
      .send({ version: 0, content: { ...content, tone: ['klar', 'warm'] } })
      .expect(200);
    const versions = await as(editor).get(`${ws}/brand-voices/${voiceId}/versions`).expect(200);
    expect(
      (versions.body as { versions: { versionNumber: number }[] }).versions.map((v) => v.versionNumber),
    ).toEqual([2, 1]);

    const test = await as(admin).post(`${ws}/brand-voices/${voiceId}/test`).send({}).expect(201);
    expect(test.body).toMatchObject({ variant: { platform: 'LINKEDIN', count: { overLimit: false } } });
    expect(test.body).not.toHaveProperty('variant.variantId');
  });

  it('suggests ideas, leaves out ones that exist already, and updates them', async () => {
    const first = await as(editor).post(`${ws}/ideas/generate`).send({ count: 3 }).expect(201);
    const ideas = (first.body as { ideas: { id: string; status: string }[]; duplicates: number }).ideas;
    expect(ideas).toHaveLength(3);
    expect(ideas.every((idea) => idea.status === 'NEW')).toBe(true);

    const second = await as(editor).post(`${ws}/ideas/generate`).send({ count: 3 }).expect(201);
    expect(second.body).toMatchObject({ ideas: [], duplicates: 3 });

    const discarded = await as(editor)
      .patch(`${ws}/ideas/${ideas[0]?.id ?? ''}`)
      .send({ version: 0, status: 'DISCARDED' })
      .expect(200);
    expect(discarded.body).toMatchObject({ status: 'DISCARDED', version: 1 });
    const list = await as(editor).get(`${ws}/ideas?status=DISCARDED`).expect(200);
    expect((list.body as { ideas: { id: string }[] }).ideas.map((idea) => idea.id)).toEqual([ideas[0]?.id]);
  });
});
