import { S3Storage, storageConfigOf } from '@smp/media';
import { GDPR_QUEUE } from '@smp/queue';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signUpVerified, type Browser } from './support/browser';

// Guide step 8.1 through the API: the owner asks for an export, gets the one that waits when
// asking again, and the job is queued for the role "gdpr"; a finished export downloads through a
// link of five minutes that names the file, and every download is audited. Expired exports and
// those of another organization are not available.

describe('data export API', () => {
  let api: ApiTestApp | undefined;
  let queue: Queue | undefined;
  let owner: Browser;
  let stranger: Browser;
  let organizationId = '';
  let strangerOrganizationId = '';

  const started = () => {
    if (!api || !queue) {
      throw new Error('not started');
    }
    return { api, queue };
  };
  const query = async <T>(sql: string, values: unknown[] = []): Promise<T[]> => {
    const client = await started().api.database.connectAs('app_system');
    try {
      return (await client.query(sql, values)).rows as T[];
    } finally {
      await client.end();
    }
  };
  /** Stores an archive as the role "gdpr" would. */
  const uploadArchive = async (key: string, bytes: Uint8Array): Promise<void> => {
    const storage = new S3Storage(storageConfigOf(started().api.env));
    try {
      await storage.put(key, bytes, { contentType: 'application/zip' });
    } finally {
      storage.destroy();
    }
  };
  const organizationOf = async (browser: Browser, name: string): Promise<string> => {
    const created = await browser
      .post('/api/organizations')
      .send({ name, workspace: { name, timezone: 'UTC', contentLanguage: 'de' } })
      .expect(201);
    return (created.body as { organizationId: string }).organizationId;
  };

  beforeAll(async () => {
    api = await startApiTestApp({ objectStorage: true });
    queue = new Queue(GDPR_QUEUE, { connection: { url: api.env.REDIS_URL } });
    owner = await signUpVerified(api, 'export-owner@acme.test', 'Erna Owner');
    stranger = await signUpVerified(api, 'export-stranger@other.test', 'Sven Stranger');
    organizationId = await organizationOf(owner, 'Export GmbH');
    strangerOrganizationId = await organizationOf(stranger, 'Other GmbH');
  });

  afterAll(async () => {
    await queue?.close();
    await api?.close();
  });

  let exportId = '';

  it('creates one waiting export and queues it for the role gdpr', async () => {
    const created = await owner.post(`/api/org/${organizationId}/data-exports`).expect(202);
    const again = await owner.post(`/api/org/${organizationId}/data-exports`).expect(202);

    expect(created.body).toMatchObject({
      status: 'PENDING',
      completedAt: null,
      expiresAt: null,
      downloadable: false,
      sizeBytes: null,
    });
    exportId = (created.body as { id: string }).id;
    expect((again.body as { id: string }).id).toBe(exportId);
    const job = await started().queue.getJob(`gdpr.${exportId}`);
    expect(job?.data).toEqual({ requestId: exportId });

    const listed = await owner.get(`/api/org/${organizationId}/data-exports`).expect(200);
    expect(listed.body).toMatchObject({ items: [{ id: exportId, status: 'PENDING' }] });
    const [audit] = await query<{ action: string; actor_user_id: string | null }>(
      `SELECT action, actor_user_id FROM audit_log WHERE organization_id = $1 AND action LIKE 'gdpr.%'`,
      [organizationId],
    );
    expect(audit).toMatchObject({ action: 'gdpr.export_requested' });
  });

  it('downloads a finished export through a short link that names the file', async () => {
    const key = `exports/${organizationId}/${exportId}.zip`;
    const archive = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array<number>(18).fill(0)]);
    await query(
      `UPDATE gdpr_request
          SET status = 'COMPLETED', started_at = now(), completed_at = now(), object_key = $2,
              expires_at = now() + interval '24 hours', details = '{"bytes": 22}'
        WHERE id = $1`,
      [exportId, key],
    );
    await uploadArchive(key, archive);

    const listed = await owner.get(`/api/org/${organizationId}/data-exports`).expect(200);
    expect(listed.body).toMatchObject({ items: [{ id: exportId, downloadable: true, sizeBytes: 22 }] });
    const link = await owner.post(`/api/org/${organizationId}/data-exports/${exportId}/download`).expect(201);
    const { url, expiresAt } = link.body as { url: string; expiresAt: string };

    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="social-media-poster-export-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(archive);
    const actions = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE organization_id = $1 AND action LIKE 'gdpr.%' ORDER BY created_at`,
      [organizationId],
    );
    expect(actions.map((row) => row.action)).toEqual(['gdpr.export_requested', 'gdpr.export_downloaded']);
  });

  it('does not hand out expired exports or those of another organization', async () => {
    const foreign = await stranger
      .post(`/api/org/${strangerOrganizationId}/data-exports/${exportId}/download`)
      .expect(404);
    expect(foreign.body).toMatchObject({ code: 'DATA_EXPORT_UNAVAILABLE' });
    await stranger.post(`/api/org/${organizationId}/data-exports/${exportId}/download`).expect(404);
    await stranger.get(`/api/org/${organizationId}/data-exports`).expect(404);

    await query(`UPDATE gdpr_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [exportId]);
    const expired = await owner
      .post(`/api/org/${organizationId}/data-exports/${exportId}/download`)
      .expect(404);
    expect(expired.body).toMatchObject({ code: 'DATA_EXPORT_UNAVAILABLE' });
    const listed = await owner.get(`/api/org/${organizationId}/data-exports`).expect(200);
    expect(listed.body).toMatchObject({ items: [{ id: exportId, downloadable: false }] });
  });
});
