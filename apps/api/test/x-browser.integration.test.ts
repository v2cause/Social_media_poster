import { X_BROWSER_RISK, type XBrowserAdminDto, type XBrowserStatusDto } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { XB_KEYS } from '@smp/x-browser';
import Redis from 'ioredis';
import type { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signIn, type Browser } from './support/browser';

// Guide step 6.1 through the API: the X browser stays closed until a platform admin allows the
// organization, an owner switches it on with the current risk text and the password again, and
// the kill switch closes it for everyone at once, in the database and for the browser worker.

const SEED_PASSWORD = 'seed-password-for-the-x-browser-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}/x-browser`;

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
    system = await api.database.connectAs('app_system');
    // Only platform operators set the flag; here the admin of the demo is one as well.
    await system.query(`UPDATE users SET is_platform_admin = true WHERE email = $1`, [emailOf('ADMIN')]);
    for (const role of ['OWNER', 'ADMIN', 'EDITOR', 'VIEWER']) {
      browsers.set(role, await signIn(api, emailOf(role), SEED_PASSWORD));
    }
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
  });

  it('keeps the switches of the platform admins to the platform admins', async () => {
    const denied = await as('OWNER').get('/api/admin/x-browser').expect(403);
    expect(denied.body).toMatchObject({ code: 'NOT_PERMITTED' });
    await as('OWNER').put('/api/admin/x-browser/kill-switch').send({ active: true }).expect(403);

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
