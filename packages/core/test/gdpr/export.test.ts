import { describe, expect, it } from 'vitest';

import {
  archiveName,
  ExpireExports,
  ExportOrganizationData,
  mediaArchiveName,
  type GdprRequest,
} from '../../src';
import {
  MemoryArchives,
  MemoryDataSource,
  MemoryGdprRequests,
  RecordingGdprNotifier,
} from '../in-memory-gdpr';
import { MemoryStorage } from '../in-memory-media';
import { MovingClock } from '../in-memory-publish-job';

// Guide step 8.1: the export packs every table of the organization as JSON and the originals of
// its media library into one archive, with a manifest that says what is inside. The owner hears
// when it is ready; after 24 hours the archive goes, and an export that hangs is given up.

const ORG = '0192f000-0000-7000-8000-000000000001';
const WS = '0192f000-0000-7000-8000-0000000000a1';
const NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const waiting = (overrides: Partial<GdprRequest> = {}): GdprRequest => ({
  id: '0192f000-0000-7000-8000-0000000000e1',
  organizationId: ORG,
  kind: 'EXPORT',
  status: 'PENDING',
  requestedById: 'user-1',
  runAfter: new Date(NOW - 60_000),
  startedAt: null,
  completedAt: null,
  objectKey: null,
  expiresAt: null,
  details: {},
  createdAt: new Date(NOW - 60_000),
  ...overrides,
});

const testbed = () => {
  const requests = new MemoryGdprRequests();
  const source = new MemoryDataSource();
  const archives = new MemoryArchives();
  const storage = new MemoryStorage();
  const notifier = new RecordingGdprNotifier();
  const clock = new MovingClock(NOW);
  source.organizations.set(ORG, {
    id: ORG,
    name: 'Acme',
    workspaces: [{ id: WS, slug: 'marketing', name: 'Marketing' }],
  });
  source.tableRows.set('organization', [{ id: ORG, name: 'Acme' }]);
  source.tableRows.set('post', [
    { id: 'p1', workspace_id: WS, title: 'Launch' },
    { id: 'p2', workspace_id: WS, title: 'Follow-up' },
  ]);
  source.tableRows.set('idea', []);
  const exporter = new ExportOrganizationData({ requests, source, archives, storage, notifier, clock });
  return { requests, source, archives, storage, notifier, clock, exporter };
};

describe('the export of an organization', () => {
  it('packs every table, the originals and a manifest, and tells the owner', async () => {
    const bed = testbed();
    bed.requests.put(waiting());
    const original = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    bed.storage.upload(`ws/${WS}/assets/a1/original`, original, 'image/jpeg');
    bed.source.mediaFiles.push(
      {
        workspaceSlug: 'marketing',
        assetId: 'a1',
        fileName: 'Team/Foto: 1.jpg',
        mimeType: 'image/jpeg',
        storageKey: `ws/${WS}/assets/a1/original`,
      },
      {
        workspaceSlug: 'marketing',
        assetId: 'a2',
        fileName: 'gone.png',
        mimeType: 'image/png',
        storageKey: `ws/${WS}/assets/a2/original`,
      },
    );

    const result = await bed.exporter.execute(waiting().id);

    const [archive] = bed.archives.created;
    expect(archive?.key).toBe(`exports/${ORG}/${waiting().id}.zip`);
    expect(archive?.finished).toBe(true);
    expect([...(archive?.files.keys() ?? [])]).toEqual([
      'README.txt',
      'data/organization.json',
      'data/post.json',
      'data/idea.json',
      'media/marketing/a1-Team_Foto_ 1.jpg',
      'manifest.json',
    ]);
    expect(archive?.json('data/post.json')).toEqual([
      { id: 'p1', workspace_id: WS, title: 'Launch' },
      { id: 'p2', workspace_id: WS, title: 'Follow-up' },
    ]);
    expect(archive?.json('data/idea.json')).toEqual([]);
    expect(archive?.files.get('media/marketing/a1-Team_Foto_ 1.jpg')).toEqual({
      body: original,
      compress: false,
    });
    expect(archive?.text('README.txt')).toContain('Secrets such as the tokens');
    expect(archive?.json('manifest.json')).toEqual({
      format: 1,
      organization: { id: ORG, name: 'Acme' },
      workspaces: [{ id: WS, slug: 'marketing', name: 'Marketing' }],
      requestedAt: new Date(NOW - 60_000).toISOString(),
      exportedAt: new Date(NOW).toISOString(),
      tables: { organization: 1, post: 2, idea: 0 },
      mediaFiles: 1,
      mediaMissing: 1,
    });

    expect(result).toMatchObject({ outcome: 'exported', tables: 3, rows: 3, mediaFiles: 1 });
    expect(bed.requests.get(waiting().id)).toMatchObject({
      status: 'COMPLETED',
      completedAt: new Date(NOW),
      objectKey: `exports/${ORG}/${waiting().id}.zip`,
      expiresAt: new Date(NOW + 24 * HOUR),
      details: { tables: 3, rows: 3, mediaFiles: 1, mediaMissing: 1 },
    });
    expect(bed.notifier.ready).toEqual([
      {
        requestId: waiting().id,
        organizationId: ORG,
        requestedById: 'user-1',
        expiresAt: new Date(NOW + 24 * HOUR),
      },
    ]);
  });

  it('skips a request that is not due, finished or no export', async () => {
    const bed = testbed();
    bed.requests.put(waiting({ id: 'later', runAfter: new Date(NOW + HOUR) }));
    bed.requests.put(waiting({ id: 'done', status: 'COMPLETED' }));
    bed.requests.put(waiting({ id: 'erasure', kind: 'ERASURE' }));

    for (const id of ['later', 'done', 'erasure', 'missing']) {
      expect(await bed.exporter.execute(id)).toEqual({ outcome: 'skipped' });
    }
    expect(bed.archives.created).toEqual([]);
    expect(bed.notifier.ready).toEqual([]);
  });

  it('drops the archive and keeps the request running when writing fails, so the job retries', async () => {
    const bed = testbed();
    bed.requests.put(waiting());
    bed.archives.failOn = 'data/post.json';

    await expect(bed.exporter.execute(waiting().id)).rejects.toThrow('storage refused data/post.json');

    expect(bed.archives.created[0]?.aborted).toBe(true);
    expect(bed.requests.get(waiting().id)?.status).toBe('RUNNING');
    expect(bed.notifier.ready).toEqual([]);

    // The retry claims the running request again and finishes it.
    bed.archives.failOn = null;
    expect((await bed.exporter.execute(waiting().id)).outcome).toBe('exported');
  });

  it('deletes the archive of an export that was given up while it ran', async () => {
    const bed = testbed();
    bed.requests.put(waiting());
    const finish = bed.requests.complete.bind(bed.requests);
    bed.requests.complete = async (id, at, result) => {
      await bed.requests.failStale('EXPORT', new Date(NOW), at);
      return finish(id, at, result);
    };
    bed.storage.upload(`exports/${ORG}/${waiting().id}.zip`, new Uint8Array([1]), 'application/zip');

    expect(await bed.exporter.execute(waiting().id)).toEqual({ outcome: 'skipped' });

    expect(bed.storage.objects.has(`exports/${ORG}/${waiting().id}.zip`)).toBe(false);
    expect(bed.requests.get(waiting().id)?.status).toBe('FAILED');
    expect(bed.notifier.ready).toEqual([]);
  });

  it('fails the request when the organization is gone', async () => {
    const bed = testbed();
    bed.requests.put(waiting());
    bed.source.organizations.clear();

    expect(await bed.exporter.execute(waiting().id)).toEqual({ outcome: 'skipped' });

    expect(bed.requests.get(waiting().id)).toMatchObject({
      status: 'FAILED',
      details: { failure: 'ORGANIZATION_GONE' },
    });
  });
});

describe('the expiry of exports', () => {
  it('deletes archives after 24 hours and gives up exports that hang for 12 hours', async () => {
    const bed = testbed();
    const expire = new ExpireExports({ requests: bed.requests, storage: bed.storage, clock: bed.clock });
    bed.requests.put(
      waiting({
        id: 'expired',
        status: 'COMPLETED',
        objectKey: 'exports/org/expired.zip',
        expiresAt: new Date(NOW - 1),
      }),
    );
    bed.requests.put(
      waiting({
        id: 'fresh',
        status: 'COMPLETED',
        objectKey: 'exports/org/fresh.zip',
        expiresAt: new Date(NOW + HOUR),
      }),
    );
    bed.requests.put(waiting({ id: 'hanging', status: 'RUNNING', createdAt: new Date(NOW - 13 * HOUR) }));
    bed.requests.put(waiting({ id: 'working', status: 'RUNNING', createdAt: new Date(NOW - 11 * HOUR) }));
    bed.storage.upload('exports/org/expired.zip', new Uint8Array([1]), 'application/zip');
    bed.storage.upload('exports/org/fresh.zip', new Uint8Array([1]), 'application/zip');

    expect(await expire.execute()).toEqual({ exportsExpired: 1, exportsTimedOut: 1 });

    expect([...bed.storage.objects.keys()]).toEqual(['exports/org/fresh.zip']);
    expect(bed.requests.get('expired')?.objectKey).toBeNull();
    expect(bed.requests.get('hanging')).toMatchObject({ status: 'FAILED', details: { failure: 'TIMEOUT' } });
    expect(bed.requests.get('working')?.status).toBe('RUNNING');
    // A second tick finds nothing left to do.
    expect(await expire.execute()).toEqual({ exportsExpired: 0, exportsTimedOut: 0 });
  });
});

describe('names inside the archive', () => {
  it('removes folders, reserved and control characters and leading dots', () => {
    expect(archiveName('a/b\\c:d*e?f"g<h>i|j.png')).toBe('a_b_c_d_e_f_g_h_i_j.png');
    expect(archiveName('..hidden')).toBe('_hidden');
    expect(archiveName('tab\there\u0000')).toBe('tabhere');
    expect(archiveName('   ')).toBe('file');
    expect(archiveName('x'.repeat(300))).toHaveLength(120);
    expect(archiveName('photo\u202Egpj.exe')).toBe('photogpj.exe');
    expect(archiveName('zero\u200Bwidth\uFEFF')).toBe('zerowidth');
  });

  it('names an original after the type of its content, not the extension it was given', () => {
    expect(mediaArchiveName('Sommerfest 2026.jpg', 'image/jpeg')).toBe('Sommerfest 2026.jpg');
    expect(mediaArchiveName('invoice.html', 'image/jpeg')).toBe('invoice.jpg');
    expect(mediaArchiveName('screenshot.JPG', 'image/png')).toBe('screenshot.png');
    expect(mediaArchiveName('setup.exe', 'image/gif')).toBe('setup.gif');
    expect(mediaArchiveName('Mr. Smith at the party', 'image/webp')).toBe('Mr. Smith at the party.webp');
    expect(mediaArchiveName('report\u202Efdp.jpg', 'image/jpeg')).toBe('reportfdp.jpg');
    expect(mediaArchiveName('.jpg', 'image/jpeg')).toBe('_jpg.jpg');
    expect(mediaArchiveName('unknown.svg', 'image/svg+xml')).toBe('unknown.bin');
    expect(mediaArchiveName('unknown.png', null)).toBe('unknown.bin');
  });
});
