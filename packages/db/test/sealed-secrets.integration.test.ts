import { randomUUID } from 'node:crypto';

import { RewrapSecrets, type SecretRewrapper } from '@smp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '@smp/testing';

import { createSystemPrismaClient, PrismaSealedSecretStore, type SystemPrismaClient } from '../src';

// Guide step 4.2: the re-wrap job reads the sealed columns of all workspaces as app_system and
// writes back only what is unchanged, without touching the version a token refresh relies on.

const org = randomUUID();
const workspaces = [randomUUID(), randomUUID()] as const;
// Sorted, so the pages of the scan are predictable.
const connections = [randomUUID(), randomUUID(), randomUUID()].sort();
const account = randomUUID();

const OLD = (label: string): Buffer => Buffer.from(`old:${label}`);
const NEW = (label: string): Buffer => Buffer.from(`new:${label}`);

/** Turns old:x into new:x and leaves new envelopes alone, like a rotation to a new KEK. */
const rewrapper: SecretRewrapper = {
  rewrap(sealed) {
    const text = Buffer.from(sealed).toString();
    return Promise.resolve(text.startsWith('old:') ? Buffer.from(text.replace('old:', 'new:')) : null);
  },
};

describe('PrismaSealedSecretStore', () => {
  let database: TestDatabase | undefined;
  let system: SystemPrismaClient | undefined;

  const store = (): PrismaSealedSecretStore => {
    if (!system) {
      throw new Error('system client missing');
    }
    return new PrismaSealedSecretStore(system);
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    if (!database) {
      throw new Error('database missing');
    }
    const client = await database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };

  beforeAll(async () => {
    database = await startTestDatabase();
    await query(`INSERT INTO organization (id, name, updated_at) VALUES ($1, 'Org', now())`, [org]);
    await query(
      `INSERT INTO workspace (id, organization_id, slug, name, timezone, content_language, updated_at)
       VALUES ($1, $3, 'secrets-1', 'One', 'Europe/Berlin', 'de', now()),
              ($2, $3, 'secrets-2', 'Two', 'Europe/Berlin', 'de', now())`,
      [workspaces[0], workspaces[1], org],
    );
    const [first, second, third] = connections;
    await query(
      `INSERT INTO social_connection (id, workspace_id, platform, method, external_user_id, display_name,
                                      access_token_sealed, refresh_token_sealed, session_sealed, version, updated_at)
       VALUES ($1, $4, 'X', 'API', 'u1', 'One', $5, $6, NULL, 3, now()),
              ($2, $7, 'X', 'BROWSER', 'u2', 'Two', NULL, NULL, $8, 0, now()),
              ($3, $7, 'LINKEDIN', 'API', 'u3', 'Three', NULL, NULL, NULL, 0, now())`,
      [first, second, third, workspaces[0], OLD('a1'), OLD('r1'), workspaces[1], NEW('s2')],
    );
    await query(
      `INSERT INTO social_account (id, workspace_id, connection_id, platform, type, external_id, name,
                                   access_token_sealed, updated_at)
       VALUES ($1, $2, $3, 'FACEBOOK', 'PAGE', 'page-1', 'Page', $4, now())`,
      [account, workspaces[0], first, OLD('p1')],
    );
    system = createSystemPrismaClient(database.url('app_system'));
  }, 300_000);

  afterAll(async () => {
    await system?.$disconnect();
    await database?.stop();
  });

  it('lists the sealed columns of every workspace in id order, page by page', async () => {
    const firstPage = await store().list('connection', null, 1);
    const secondPage = await store().list('connection', firstPage.at(-1)?.id ?? null, 5);

    expect(firstPage).toHaveLength(1);
    // The connection without any sealed column is left out.
    expect([...firstPage, ...secondPage].map((row) => row.id)).toEqual(connections.slice(0, 2));
    expect(firstPage[0]?.workspaceId).toBe(workspaces[0]);
    expect(Object.keys(firstPage[0]?.secrets ?? {}).sort()).toEqual(['accessToken', 'refreshToken']);
    expect(Buffer.from(secondPage[0]?.secrets.session ?? []).toString()).toBe('new:s2');
    const accounts = await store().list('account', null, 5);
    expect(accounts.map((row) => row.id)).toEqual([account]);
  });

  it('writes only over the bytes it read and leaves the version alone', async () => {
    const [first] = connections;
    if (!first) {
      throw new Error('fixture missing');
    }
    await expect(store().replace('connection', first, 'accessToken', OLD('other'), NEW('a1'))).resolves.toBe(
      false,
    );
    await expect(store().replace('connection', first, 'accessToken', OLD('a1'), NEW('a1'))).resolves.toBe(
      true,
    );
    await expect(store().replace('connection', first, 'accessToken', OLD('a1'), NEW('a1'))).resolves.toBe(
      false,
    );

    const [row] = await query<{ access_token_sealed: Buffer; version: number }>(
      'SELECT access_token_sealed, version FROM social_connection WHERE id = $1',
      [first],
    );
    expect(row?.access_token_sealed.toString()).toBe('new:a1');
    expect(row?.version).toBe(3);
  });

  it('moves the remaining envelopes with RewrapSecrets', async () => {
    const report = await new RewrapSecrets({
      store: store(),
      rewrappers: { tokens: rewrapper, sessions: rewrapper },
      batchSize: 1,
    }).execute();

    expect(report).toEqual({ checked: 4, rewrapped: 2, changedMeanwhile: 0, failed: 0 });
    const sealed = await query<{ value: string }>(
      `SELECT convert_from(access_token_sealed, 'UTF8') AS value FROM social_connection WHERE access_token_sealed IS NOT NULL
       UNION ALL SELECT convert_from(refresh_token_sealed, 'UTF8') FROM social_connection WHERE refresh_token_sealed IS NOT NULL
       UNION ALL SELECT convert_from(session_sealed, 'UTF8') FROM social_connection WHERE session_sealed IS NOT NULL
       UNION ALL SELECT convert_from(access_token_sealed, 'UTF8') FROM social_account`,
    );
    expect(sealed.map((row) => row.value).sort()).toEqual(['new:a1', 'new:p1', 'new:r1', 'new:s2']);
  });
});
