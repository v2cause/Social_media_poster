import { connectionSecretAad } from '@smp/core';
import type {
  AuthorizationUrlDto,
  ConfirmedConnectionDto,
  PendingConnectionDto,
  SocialAccountListDto,
} from '@smp/contracts';
import { sealerFromEnv } from '@smp/crypto';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { PLATFORM_SCOPES } from '@smp/platform-adapters';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, TEST_TOKEN_KEKS, type ApiTestApp } from './support/api-app';
import { browser, signIn, type Browser } from './support/browser';

// Guide step 4.5, "Fertig, wenn": the whole OAuth flow with the mock consent page, including a
// refused consent and an expired state. Like a browser: start, consent page, callback, selection,
// confirmation; then reconnect and disconnect.

const SEED_PASSWORD = 'seed-password-for-the-channels-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}`;
type Choice = 'allow' | 'partial' | 'deny';

const userOf = (role: string) => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo user with role ${role}`);
  }
  return user;
};

/** The links of the consent page in their order: allow, the partial grant if offered, deny. */
const linksOf = (html: string): Record<Choice, string | undefined> => {
  const hrefs = [...html.matchAll(/<a class="\w+" href="([^"]+)">/g)].map((match) =>
    (match[1] ?? '').replaceAll('&amp;', '&'),
  );
  return { allow: hrefs[0], partial: hrefs.length === 3 ? hrefs[1] : undefined, deny: hrefs.at(-1) };
};

const pathOf = (url: string): string => {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
};

describe('channels API with the mock OAuth', () => {
  let api: ApiTestApp | undefined;
  let redis: Redis | undefined;
  let owner: Browser | undefined;
  let admin: Browser | undefined;
  let editor: Browser | undefined;
  let workspaceId = '';

  const as = (agent: Browser | undefined): Browser => {
    if (!agent) {
      throw new Error('not signed in');
    }
    return agent;
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!api) {
      throw new Error('API is not running');
    }
    const connection = await api.database.connectAs('app_system');
    try {
      return (await connection.query(sql, values)).rows as T[];
    } finally {
      await connection.end();
    }
  };

  /** Starts a connection and opens the consent page; returns its links. */
  const consentPage = async (agent: Browser, start: string): Promise<Record<Choice, string | undefined>> => {
    const { authorizationUrl } = (await agent.post(start).expect(200)).body as AuthorizationUrlDto;
    const page = await agent.get(pathOf(authorizationUrl)).expect(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    return linksOf(page.text);
  };

  /** Follows one link of the consent page to the callback; returns where the callback sends the browser. */
  const callback = async (agent: Browser, link: string | undefined): Promise<URL> => {
    if (!link) {
      throw new Error('the consent page does not offer this choice');
    }
    const response = await agent.get(pathOf(link)).expect(302);
    return new URL(response.headers['location'] as string);
  };

  /** The whole consent; returns the id of the pending connection. */
  const consent = async (agent: Browser, start: string, choice: Choice = 'allow'): Promise<string> => {
    const location = await callback(agent, (await consentPage(agent, start))[choice]);
    expect(location.pathname).toBe(`/w/${DEMO_WORKSPACE_SLUG}/accounts/connect/select`);
    return location.searchParams.get('pending') ?? '';
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    redis = new Redis(api.env.REDIS_URL);
    const system = createPrismaClient(api.database.url('app_system'));
    try {
      await seedDemoData(system, SEED_PASSWORD);
      workspaceId = (await system.workspace.findFirstOrThrow({ where: { slug: DEMO_WORKSPACE_SLUG } })).id;
    } finally {
      await system.$disconnect();
    }
    owner = await signIn(api, userOf('OWNER').email, SEED_PASSWORD);
    admin = await signIn(api, userOf('ADMIN').email, SEED_PASSWORD);
    editor = await signIn(api, userOf('EDITOR').email, SEED_PASSWORD);
  }, 300_000);

  afterAll(async () => {
    redis?.disconnect();
    await api?.close();
  });

  it('offers the four mock platforms and lets only owners and admins connect', async () => {
    const options = (await as(editor).get(`${ws}/channels`).expect(200)).body as { items: unknown[] };
    expect(options.items).toEqual([
      { platform: 'LINKEDIN', method: 'MOCK' },
      { platform: 'INSTAGRAM', method: 'MOCK' },
      { platform: 'FACEBOOK', method: 'MOCK' },
      { platform: 'X', method: 'MOCK' },
    ]);
    await as(editor).post(`${ws}/channels/linkedin/connect`).expect(403);
    await as(owner).post(`${ws}/channels/myspace/connect`).expect(404);
  });

  it('connects LinkedIn: consent, selection, confirmation, sealed tokens', async () => {
    const pendingId = await consent(as(owner), `${ws}/channels/linkedin/connect`);

    const pending = (await as(owner).get(`${ws}/channels/pending/${pendingId}`).expect(200))
      .body as PendingConnectionDto;
    expect(pending).toMatchObject({
      platform: 'LINKEDIN',
      method: 'MOCK',
      displayName: 'Mock mock-user',
      missingScopes: [],
      reconnectAccountId: null,
    });
    expect(pending.accounts.map((account) => [account.type, account.connected])).toEqual([
      ['PROFILE', false],
      ['PAGE', false],
      ['PAGE', false],
    ]);
    // Somebody else cannot see the consent of the owner.
    await as(admin).get(`${ws}/channels/pending/${pendingId}`).expect(404);

    const picked = pending.accounts.slice(0, 2).map((account) => account.externalId);
    const confirmed = (
      await as(owner)
        .post(`${ws}/channels/pending/${pendingId}/confirm`)
        .send({ externalIds: picked })
        .expect(200)
    ).body as ConfirmedConnectionDto;
    expect(confirmed.accountIds).toHaveLength(2);
    await as(owner).get(`${ws}/channels/pending/${pendingId}`).expect(404);

    const accounts = (await as(editor).get(`${ws}/accounts`).expect(200)).body as SocialAccountListDto;
    expect(accounts.items).toHaveLength(2);
    expect(accounts.items[0]).toMatchObject({
      platform: 'LINKEDIN',
      method: 'MOCK',
      status: 'ACTIVE',
      connectionId: confirmed.connectionId,
      missingScopes: [],
      // Calls to LinkedIn cost nothing; only X accounts carry costs.
      costMicros: null,
    });
    const expiresInDays = (Date.parse(accounts.items[0]?.accessExpiresAt ?? '') - Date.now()) / 86_400_000;
    expect(expiresInDays).toBeGreaterThan(59);

    const [row] = await query<{ access_token_sealed: Buffer; refresh_token_sealed: Buffer | null }>(
      'SELECT access_token_sealed, refresh_token_sealed FROM social_connection WHERE id = $1',
      [confirmed.connectionId],
    );
    expect(row?.access_token_sealed.toString('latin1')).not.toContain('mock-access');
    expect(row?.refresh_token_sealed).toBeNull();
    const sealer = sealerFromEnv('tokens', { TOKEN_KEKS: TEST_TOKEN_KEKS, TOKEN_KEK_ACTIVE: 'test-kek' });
    await expect(
      sealer.open(
        row?.access_token_sealed ?? Buffer.alloc(0),
        connectionSecretAad(workspaceId, confirmed.connectionId, 'access_token'),
      ),
    ).resolves.toMatch(/^mock-access-/);
    const [audit] = await query<{ action: string }>(`SELECT action FROM audit_log WHERE target_id = $1`, [
      confirmed.connectionId,
    ]);
    expect(audit?.action).toBe('channel.connect');
  });

  it('names the scopes a partial consent leaves out and seals the page tokens', async () => {
    const pendingId = await consent(as(admin), `${ws}/channels/facebook/connect`, 'partial');

    const pending = (await as(admin).get(`${ws}/channels/pending/${pendingId}`).expect(200))
      .body as PendingConnectionDto;
    expect(pending.missingScopes).toEqual(['read_insights']);
    expect(pending.grantedScopes).toEqual(
      PLATFORM_SCOPES.FACEBOOK.filter((scope) => scope !== 'read_insights'),
    );
    const page = pending.accounts[0]?.externalId ?? '';
    const { accountIds } = (
      await as(admin)
        .post(`${ws}/channels/pending/${pendingId}/confirm`)
        .send({ externalIds: [page] })
        .expect(200)
    ).body as ConfirmedConnectionDto;

    const accounts = (await as(admin).get(`${ws}/accounts`).expect(200)).body as SocialAccountListDto;
    expect(accounts.items.find((account) => account.id === accountIds[0])?.missingScopes).toEqual([
      'read_insights',
    ]);
    const [row] = await query<{ access_token_sealed: Buffer | null }>(
      'SELECT access_token_sealed FROM social_account WHERE id = $1',
      [accountIds[0]],
    );
    expect(row?.access_token_sealed).not.toBeNull();
  });

  it('keeps the PKCE verifier of X on the server', async () => {
    const { authorizationUrl } = (await as(owner).post(`${ws}/channels/x/connect`).expect(200))
      .body as AuthorizationUrlDto;
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get('state') ?? '';
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/);
    expect(authorizationUrl).not.toMatch(/verifier/i);
    const stored = JSON.parse((await redis?.get(`oauth:state:${state}`)) ?? '{}') as {
      codeVerifier?: string;
    };
    expect(stored.codeVerifier).toMatch(/^[\w-]{43}$/);
    expect(await redis?.pttl(`oauth:state:${state}`)).toBeGreaterThan(9 * 60 * 1000);

    // The mock connector exchanges the code only with the verifier that matches the challenge.
    const page = await as(owner).get(pathOf(authorizationUrl)).expect(200);
    const location = await callback(as(owner), linksOf(page.text).allow);
    expect(location.pathname).toBe(`/w/${DEMO_WORKSPACE_SLUG}/accounts/connect/select`);
  });

  it('returns to the accounts page when the consent is refused', async () => {
    const location = await callback(
      as(owner),
      (await consentPage(as(owner), `${ws}/channels/x/connect`)).deny,
    );

    expect(`${location.pathname}${location.search}`).toBe(
      `/w/${DEMO_WORKSPACE_SLUG}/accounts?connect_error=ACCESS_DENIED`,
    );
  });

  it('refuses an expired state and a state used before', async () => {
    const links = await consentPage(as(owner), `${ws}/channels/instagram/connect`);
    const state = new URL(links.allow ?? '').searchParams.get('state') ?? '';
    await redis?.pexpire(`oauth:state:${state}`, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const expired = await callback(as(owner), links.allow);
    expect(`${expired.pathname}${expired.search}`).toBe('/?connect_error=STATE_INVALID');

    const fresh = await consentPage(as(owner), `${ws}/channels/instagram/connect`);
    expect((await callback(as(owner), fresh.allow)).pathname).toMatch(/\/connect\/select$/);
    expect((await callback(as(owner), fresh.allow)).searchParams.get('connect_error')).toBe('STATE_INVALID');
  });

  it('refuses the callback in the session of another user and sends one without session to sign in', async () => {
    if (!api) {
      throw new Error('API is not running');
    }
    const links = await consentPage(as(owner), `${ws}/channels/linkedin/connect`);

    const anonymous = await callback(browser(api.server), links.allow);
    expect(`${anonymous.pathname}${anonymous.search}`).toBe('/login');

    const foreign = await callback(as(admin), links.allow);
    expect(foreign.searchParams.get('connect_error')).toBe('USER_MISMATCH');
    // The state is gone with that attempt.
    expect((await callback(as(owner), links.allow)).searchParams.get('connect_error')).toBe('STATE_INVALID');
  });

  it('reconnects an account under its connection and disconnects it, revoking the grant', async () => {
    const before = (await as(owner).get(`${ws}/accounts`).expect(200)).body as SocialAccountListDto;
    const linkedIn = before.items.filter((account) => account.platform === 'LINKEDIN');
    const [first] = linkedIn;
    if (!first) {
      throw new Error('no LinkedIn account connected');
    }

    const pendingId = await consent(as(owner), `${ws}/accounts/${first.id}/reconnect`);
    const pending = (await as(owner).get(`${ws}/channels/pending/${pendingId}`).expect(200))
      .body as PendingConnectionDto;
    expect(pending.reconnectAccountId).toBe(first.id);
    expect(pending.accounts.filter((account) => account.connected)).toHaveLength(2);
    const again = (
      await as(owner)
        .post(`${ws}/channels/pending/${pendingId}/confirm`)
        .send({
          externalIds: pending.accounts.filter((account) => account.connected).map((a) => a.externalId),
        })
        .expect(200)
    ).body as ConfirmedConnectionDto;
    expect(again.connectionId).toBe(first.connectionId);
    expect(new Set(again.accountIds)).toEqual(new Set(linkedIn.map((account) => account.id)));

    await as(editor).delete(`${ws}/accounts/${first.id}`).expect(403);
    for (const account of linkedIn) {
      await as(owner).delete(`${ws}/accounts/${account.id}`).expect(204);
    }
    await as(owner).delete(`${ws}/accounts/${first.id}`).expect(404);

    const after = (await as(owner).get(`${ws}/accounts`).expect(200)).body as SocialAccountListDto;
    expect(after.items.filter((account) => account.platform === 'LINKEDIN')).toEqual([]);
    const [connection] = await query<{ status: string; access_token_sealed: Buffer | null; version: number }>(
      'SELECT status, access_token_sealed, version FROM social_connection WHERE id = $1',
      [first.connectionId],
    );
    expect(connection).toEqual({ status: 'REVOKED', access_token_sealed: null, version: 2 });
    const actions = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action LIKE 'channel.%' AND workspace_id = $1 ORDER BY created_at`,
      [workspaceId],
    );
    expect(actions.map((entry) => entry.action)).toEqual([
      'channel.connect',
      'channel.connect',
      'channel.reconnect',
      'channel.disconnect',
      'channel.disconnect',
    ]);
  });

  it('keeps the consent page from sending codes anywhere but to the callback of the app', async () => {
    const page = new URLSearchParams({
      platform: 'X',
      state: 'state-0123456789abcdef',
      redirect_uri: 'https://evil.example/api/oauth/x/callback',
      scope: 'tweet.read',
    });
    await as(owner).get(`/api/dev/mock-oauth/authorize?${page.toString()}`).expect(400);
  });
});
