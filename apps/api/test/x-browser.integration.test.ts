import { setTimeout as sleep } from 'node:timers/promises';

import {
  X_BROWSER_RISK,
  type XBrowserAdminDto,
  type XBrowserStatusDto,
  type XbLoginSessionDto,
} from '@smp/contracts';
import { sealerFromEnv } from '@smp/crypto';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { RedisBrowserLoginStore } from '@smp/platform-adapters';
import { liveEventChannel } from '@smp/queue';
import { totpCodes } from '@smp/testing';
import { parseXbCommand, XB_COMMANDS_QUEUE, XB_KEYS, xbLoginAad } from '@smp/x-browser';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signIn, signUpVerified, type Browser } from './support/browser';
import { onPlan } from './support/plan';

// Guide steps 6.1 and 6.4 through the API: the X browser stays closed until the plan of the
// organization includes it or a platform admin allows the organization (guide step 7.4), an
// owner switches it on with the current risk text and the password
// again, and the kill switch closes it for everyone at once, in the database and for the browser
// worker. A login of X hands the credentials and the codes to the browser worker sealed with the
// session keyring; Redis never holds them in plain text.

const SEED_PASSWORD = 'seed-password-for-the-x-browser-test';
const X_PASSWORD = 'the-password-of-the-x-account';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}/x-browser`;
const logins = `${ws}/login-sessions`;
const loginBody = { username: 'smp_demo', password: X_PASSWORD, locale: 'en' };

/** The keys of Redis that hold the text in plain, in any of their values. */
async function keysHolding(redis: Redis, text: string): Promise<string[]> {
  const found: string[] = [];
  for (const key of await redis.keys('*')) {
    const type = await redis.type(key);
    const values =
      type === 'string'
        ? [(await redis.get(key)) ?? '']
        : type === 'hash'
          ? Object.values(await redis.hgetall(key))
          : type === 'list'
            ? await redis.lrange(key, 0, -1)
            : type === 'set'
              ? await redis.smembers(key)
              : type === 'zset'
                ? await redis.zrange(key, 0, -1)
                : type === 'stream'
                  ? (await redis.xrange(key, '-', '+')).flatMap(([, fields]) => fields)
                  : [];
    if (values.some((value) => value.includes(text))) {
      found.push(key);
    }
  }
  return found;
}

const emailOf = (role: string): string => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo ${role}`);
  }
  return user.email;
};

const enableBody = (password = SEED_PASSWORD) => ({
  version: X_BROWSER_RISK.version,
  locale: 'de',
  accepted: true,
  password,
});

describe('X browser API', () => {
  let api: ApiTestApp | undefined;
  let system: Client | undefined;
  let redis: Redis | undefined;
  const browsers = new Map<string, Browser>();
  let organizationId = '';

  const as = (role: string): Browser => {
    const agent = browsers.get(role);
    if (!agent) {
      throw new Error(`no session for ${role}`);
    }
    return agent;
  };
  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };

  beforeAll(async () => {
    api = await startApiTestApp({ env: { FEATURE_X_BROWSER_GLOBAL: 'true' } });
    const prisma = createPrismaClient(api.database.url('app_system'));
    try {
      organizationId = (await seedDemoData(prisma, SEED_PASSWORD)).organizationId;
    } finally {
      await prisma.$disconnect();
    }
    // Starter does not include the X browser, so the switch of the platform admins decides.
    await onPlan(api, organizationId, 'starter');
    system = await api.database.connectAs('app_system');
    // Only platform operators set the flag; here the admin of the demo is one as well.
    await system.query(`UPDATE users SET is_platform_admin = true WHERE email = $1`, [emailOf('ADMIN')]);
    for (const role of ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']) {
      browsers.set(role, await signIn(api, emailOf(role), SEED_PASSWORD));
    }
    // The switches of the platform admins need a second factor (guide step 8.4).
    const admin = browsers.get('ADMIN');
    const enabled = await admin
      ?.post('/api/auth/two-factor/enable')
      .send({ password: SEED_PASSWORD })
      .expect(200);
    const code = totpCodes((enabled?.body as { totpURI: string }).totpURI);
    await admin?.post('/api/auth/two-factor/verify-totp').send({ code: code() }).expect(200);
    redis = new Redis(api.env.REDIS_URL);
  });

  afterAll(async () => {
    redis?.disconnect();
    await system?.end();
    await api?.close();
  });

  it('stays closed for the workspace until the organization may use it', async () => {
    const status = await as('VIEWER').get(ws).expect(200);
    expect(status.body as XBrowserStatusDto).toEqual({
      available: false,
      blocks: ['plan', 'workspace', 'acknowledgement'],
      enabled: false,
      currentVersion: X_BROWSER_RISK.version,
      acknowledgement: null,
    });
    const refused = await as('OWNER').post(`${ws}/activation`).send(enableBody()).expect(409);
    expect(refused.body).toMatchObject({ code: 'X_BROWSER_UNAVAILABLE' });

    // Pro includes it: only the switch of the workspace and the acknowledgement are left.
    await onPlan(started(), organizationId, 'pro');
    try {
      const withPlan = await as('VIEWER').get(ws).expect(200);
      expect((withPlan.body as XBrowserStatusDto).blocks).toEqual(['workspace', 'acknowledgement']);
    } finally {
      await onPlan(started(), organizationId, 'starter');
    }
  });

  it('keeps the switches of the platform admins to the platform admins with a second factor', async () => {
    const denied = await as('OWNER').get('/api/admin/x-browser').expect(403);
    expect(denied.body).toMatchObject({ code: 'NOT_PERMITTED' });
    await as('OWNER').put('/api/admin/x-browser/kill-switch').send({ active: true }).expect(403);
    const withoutSecondFactor = await signUpVerified(started(), 'operator@platform.test', 'Otto Operator');
    await system?.query(`UPDATE users SET is_platform_admin = true WHERE email = $1`, [
      'operator@platform.test',
    ]);
    const refused = await withoutSecondFactor.get('/api/admin/x-browser').expect(403);
    expect(refused.body).toMatchObject({ code: 'TWO_FACTOR_REQUIRED' });
    await withoutSecondFactor.put('/api/admin/x-browser/kill-switch').send({ active: true }).expect(403);

    const allowed = await as('ADMIN')
      .post('/api/admin/x-browser/organizations')
      .send({ workspaceSlug: DEMO_WORKSPACE_SLUG })
      .expect(200);
    expect(allowed.body).toEqual({ id: organizationId, name: expect.any(String) as string });
    const view = await as('ADMIN').get('/api/admin/x-browser').expect(200);
    expect(view.body as XBrowserAdminDto).toMatchObject({
      offered: true,
      killSwitch: { active: false, updatedAt: null },
      organizations: [{ id: organizationId }],
    });
    await as('ADMIN')
      .post('/api/admin/x-browser/organizations')
      .send({ workspaceSlug: 'no-such-workspace' })
      .expect(404);
  });

  it('switches on with the current text, the checkbox and the password', async () => {
    await as('EDITOR').post(`${ws}/activation`).send(enableBody()).expect(403);
    const wrong = await as('OWNER').post(`${ws}/activation`).send(enableBody('not-the-password')).expect(422);
    expect(wrong.body).toMatchObject({ code: 'INVALID_PASSWORD' });
    const outdated = await as('OWNER')
      .post(`${ws}/activation`)
      .send({ ...enableBody(), version: '2020-01-01' })
      .expect(409);
    expect(outdated.body).toMatchObject({ code: 'RISK_TEXT_OUTDATED' });
    await as('OWNER')
      .post(`${ws}/activation`)
      .send({ ...enableBody(), accepted: false })
      .expect(400);

    const enabled = await as('OWNER').post(`${ws}/activation`).send(enableBody()).expect(200);
    expect(enabled.body as XBrowserStatusDto).toMatchObject({
      available: true,
      blocks: [],
      enabled: true,
      acknowledgement: {
        version: X_BROWSER_RISK.version,
        locale: 'de',
        acceptedBy: { name: expect.any(String) as string },
      },
    });

    const { rows } = await (system as Client).query<{ text_hash: string; ip_address: string }>(
      `SELECT text_hash, ip_address FROM risk_acknowledgement WHERE revoked_at IS NULL`,
    );
    expect(rows).toEqual([{ text_hash: X_BROWSER_RISK.hashes.de, ip_address: expect.any(String) as string }]);
    const audit = await (system as Client).query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action LIKE 'x_browser.%' ORDER BY created_at`,
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['x_browser.enable']);
  });

  it('closes everything with the kill switch, also for the browser worker', async () => {
    const on = await as('ADMIN').put('/api/admin/x-browser/kill-switch').send({ active: true }).expect(200);
    expect((on.body as XBrowserAdminDto).killSwitch.active).toBe(true);
    await expect(redis?.exists(XB_KEYS.kill)).resolves.toBe(1);
    const status = await as('VIEWER').get(ws).expect(200);
    expect(status.body as XBrowserStatusDto).toMatchObject({
      available: false,
      blocks: ['kill_switch'],
      enabled: true,
    });

    await as('ADMIN').put('/api/admin/x-browser/kill-switch').send({ active: false }).expect(200);
    await expect(redis?.exists(XB_KEYS.kill)).resolves.toBe(0);
    expect(((await as('VIEWER').get(ws).expect(200)).body as XBrowserStatusDto).available).toBe(true);
  });

  it('starts a login of X with sealed credentials and passes a code on sealed', async () => {
    const env = started().env;
    const sessions = sealerFromEnv('sessions', env);
    const [workspace] = (
      await (system as Client).query<{ id: string }>('SELECT id FROM workspace WHERE slug = $1', [
        DEMO_WORKSPACE_SLUG,
      ])
    ).rows;
    const workspaceId = workspace?.id ?? '';
    const live = new Redis(env.REDIS_URL);
    const events: unknown[] = [];
    live.on('message', (_channel: string, message: string) => {
      events.push(JSON.parse(message));
    });
    await live.subscribe(liveEventChannel(workspaceId));
    const commands = new Queue(XB_COMMANDS_QUEUE, { connection: { url: env.REDIS_URL } });
    try {
      await as('EDITOR').post(logins).send(loginBody).expect(403);
      await as('OWNER')
        .post(logins)
        .send({ ...loginBody, reconnectAccountId: '0192f5d4-0000-7000-8000-00000000abcd' })
        .expect(404);
      const login = (await as('OWNER').post(logins).send(loginBody).expect(201)).body as XbLoginSessionDto;
      expect(login).toEqual({
        id: expect.any(String) as string,
        status: 'STARTING',
        failure: null,
        accountId: null,
        expiresAt: expect.any(String) as string,
      });

      // Only the job of the browser worker carries the credentials, sealed with the session keyring.
      const job = await commands.getJob(`xb.login.start.${login.id}`);
      const command = parseXbCommand('login.start', job?.data);
      expect(command).toMatchObject({ loginSessionId: login.id, workspaceId, locale: 'en' });
      const credentials = await sessions.open(
        Buffer.from(command.credentials, 'base64'),
        xbLoginAad(workspaceId, login.id, 'credentials'),
      );
      expect(JSON.parse(credentials)).toEqual({ username: 'smp_demo', password: X_PASSWORD });
      expect(await keysHolding(redis as Redis, X_PASSWORD)).toEqual([]);

      await expect(as('OWNER').get(`${logins}/${login.id}`).expect(200)).resolves.toMatchObject({
        body: { id: login.id, status: 'STARTING' },
      });
      const someoneElse = await as('ADMIN').get(`${logins}/${login.id}`).expect(404);
      expect(someoneElse.body).toMatchObject({ code: 'XB_LOGIN_NOT_FOUND' });
      await as('OWNER').get(`${logins}/not-a-login`).expect(404);
      const early = await as('OWNER').post(`${logins}/${login.id}/code`).send({ code: '123456' }).expect(409);
      expect(early.body).toMatchObject({ code: 'XB_LOGIN_NOT_AWAITING_CODE' });

      // The browser worker reports that X asks for a code.
      await new RedisBrowserLoginStore(redis as Redis).transition(login.id, ['STARTING'], {
        status: 'AWAITING_2FA',
      });
      await as('OWNER').post(`${logins}/${login.id}/code`).send({ code: '12 34' }).expect(400);
      const verifying = await as('OWNER')
        .post(`${logins}/${login.id}/code`)
        .send({ code: ' 123456 ' })
        .expect(200);
      expect(verifying.body).toMatchObject({ id: login.id, status: 'VERIFYING' });
      const codes = await (redis as Redis).lrange(XB_KEYS.loginInput(login.id), 0, -1);
      expect(codes).toHaveLength(1);
      await expect(
        sessions.open(Buffer.from(codes[0] ?? '', 'base64'), xbLoginAad(workspaceId, login.id, 'code')),
      ).resolves.toBe('123456');
      await as('OWNER').post(`${logins}/${login.id}/code`).send({ code: '654321' }).expect(409);

      for (let waited = 0; events.length === 0 && waited < 50; waited += 1) {
        await sleep(100);
      }
      expect(events).toEqual([
        {
          type: 'xb.login',
          loginSessionId: login.id,
          status: 'VERIFYING',
          userId: expect.any(String) as string,
        },
      ]);
    } finally {
      await commands.close();
      live.disconnect();
    }
  });

  it('refuses a sixth login of X in the hour of a workspace', async () => {
    const [workspace] = (
      await (system as Client).query<{ id: string }>('SELECT id FROM workspace WHERE slug = $1', [
        DEMO_WORKSPACE_SLUG,
      ])
    ).rows;
    // Five starts in this hour and the next, so the test does not depend on the time it runs.
    const hour = Math.floor(Date.now() / 3_600_000);
    for (const window of [hour, hour + 1]) {
      await (redis as Redis).set(
        `x-browser:login-starts:${workspace?.id ?? ''}:${String(window)}`,
        '5',
        'EX',
        7_200,
      );
    }
    const refused = await as('ADMIN').post(logins).send(loginBody).expect(429);
    expect(refused.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
  });

  it('switches off and revokes the acknowledgement; the organization can be taken off again', async () => {
    const off = await as('ADMIN').delete(`${ws}/activation`).expect(200);
    expect(off.body as XBrowserStatusDto).toMatchObject({
      available: false,
      blocks: ['workspace', 'acknowledgement'],
      enabled: false,
      acknowledgement: null,
    });
    await as('ADMIN').delete(`/api/admin/x-browser/organizations/${organizationId}`).expect(204);
    expect(
      ((await as('ADMIN').get('/api/admin/x-browser').expect(200)).body as XBrowserAdminDto).organizations,
    ).toEqual([]);
  });

  it('stops guessing the password after five attempts in 15 minutes', async () => {
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await as('ADMIN').post(`${ws}/activation`).send(enableBody('wrong-password')).expect(422);
    }
    const blocked = await as('ADMIN').post(`${ws}/activation`).send(enableBody()).expect(429);
    expect(blocked.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
    expect(started().env.FEATURE_X_BROWSER_GLOBAL).toBe(true);
  });
});
