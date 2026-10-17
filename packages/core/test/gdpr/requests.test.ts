import { describe, expect, it } from 'vitest';

import {
  DataExportUnavailableError,
  DownloadDataExport,
  ListDataExports,
  NotPermittedError,
  RequestDataExport,
  type GdprRequest,
  type OrganizationActor,
} from '../../src';
import { MemoryGdprRequests, MemoryGdprUnitOfWork, RecordingGdprJobs } from '../in-memory-gdpr';
import { MemoryStorage } from '../in-memory-media';
import { MovingClock } from '../in-memory-publish-job';
import { SequentialIds } from '../in-memory-tenancy';

// Guide step 8.1: the owners of an organization ask for an export of all its data, see their
// exports and download a finished one with a link that lasts a few minutes. Nobody else may, and
// two exports never wait at the same time.

const ORG = '0192f000-0000-7000-8000-000000000001';
const OTHER_ORG = '0192f000-0000-7000-8000-000000000002';
const owner: OrganizationActor = { userId: 'user-1', organizationId: ORG, role: 'OWNER' };
const admin: OrganizationActor = { userId: 'user-2', organizationId: ORG, role: 'ADMIN' };
const NOW = Date.parse('2026-10-17T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const exportOf = (overrides: Partial<GdprRequest> = {}): GdprRequest => ({
  id: '0192f000-0000-7000-8000-0000000000e1',
  organizationId: ORG,
  kind: 'EXPORT',
  status: 'COMPLETED',
  requestedById: 'user-1',
  runAfter: new Date(NOW - 2 * HOUR),
  startedAt: new Date(NOW - 2 * HOUR),
  completedAt: new Date(NOW - HOUR),
  objectKey: `exports/${ORG}/0192f000-0000-7000-8000-0000000000e1.zip`,
  expiresAt: new Date(NOW + 23 * HOUR),
  details: {},
  createdAt: new Date(NOW - 2 * HOUR),
  ...overrides,
});

const testbed = () => {
  const requests = new MemoryGdprRequests();
  const unitOfWork = new MemoryGdprUnitOfWork(requests);
  const jobs = new RecordingGdprJobs();
  const clock = new MovingClock(NOW);
  const storage = new MemoryStorage();
  const signed: { key: string; options: { expiresInSeconds: number; downloadName?: string } }[] = [];
  const deps = { unitOfWork, jobs, clock, ids: new SequentialIds() };
  return {
    requests,
    unitOfWork,
    jobs,
    clock,
    request: new RequestDataExport(deps),
    list: new ListDataExports(deps),
    download: new DownloadDataExport({
      unitOfWork,
      clock,
      storage: {
        signedGetUrl: (key, options) => {
          signed.push({ key, options });
          return storage.signedGetUrl(key);
        },
      },
    }),
    signed,
  };
};

describe('asking for an export', () => {
  it('creates a waiting export, hands it to the worker and writes the audit log', async () => {
    const bed = testbed();

    const created = await bed.request.execute(owner);

    expect(created).toMatchObject({
      organizationId: ORG,
      kind: 'EXPORT',
      status: 'PENDING',
      requestedById: 'user-1',
      runAfter: new Date(NOW),
    });
    expect(bed.unitOfWork.scopes).toEqual([{ userId: 'user-1', organizationId: ORG }]);
    expect(bed.jobs.exports).toEqual([created.id]);
    expect(bed.requests.audit).toEqual([
      {
        organizationId: ORG,
        action: 'gdpr.export_requested',
        targetType: 'GdprRequest',
        targetId: created.id,
      },
    ]);
  });

  it('gives the waiting export back instead of a second one and queues it again', async () => {
    const bed = testbed();
    const first = await bed.request.execute(owner);

    const second = await bed.request.execute(owner);

    expect(second.id).toBe(first.id);
    expect(bed.requests.rows.size).toBe(1);
    // The job id of the request keeps it one job; a lost job comes back.
    expect(bed.jobs.exports).toEqual([first.id, first.id]);
    expect(bed.requests.audit).toHaveLength(1);
  });

  it('does not queue an export that runs already', async () => {
    const bed = testbed();
    bed.requests.put(exportOf({ status: 'RUNNING', completedAt: null, objectKey: null, expiresAt: null }));

    const running = await bed.request.execute(owner);

    expect(running.status).toBe('RUNNING');
    expect(bed.jobs.exports).toEqual([]);
  });

  it('takes the export of a parallel call that was faster', async () => {
    const bed = testbed();
    const parallel = exportOf({ status: 'PENDING', completedAt: null, objectKey: null, expiresAt: null });
    bed.requests.raceWith = parallel;

    const result = await bed.request.execute(owner);

    expect(result.id).toBe(parallel.id);
    expect(bed.requests.rows.size).toBe(1);
    expect(bed.requests.audit).toEqual([]);
  });

  it('is for owners only', async () => {
    const bed = testbed();

    await expect(bed.request.execute(admin)).rejects.toBeInstanceOf(NotPermittedError);
    await expect(bed.list.execute(admin)).rejects.toBeInstanceOf(NotPermittedError);
    await expect(bed.download.execute(admin, exportOf().id)).rejects.toBeInstanceOf(NotPermittedError);
    expect(bed.requests.rows.size).toBe(0);
  });
});

describe('the list of exports', () => {
  it('shows the exports of the organization, newest first', async () => {
    const bed = testbed();
    bed.requests.put(exportOf({ id: 'old', createdAt: new Date(NOW - 48 * HOUR) }));
    bed.requests.put(exportOf({ id: 'new', createdAt: new Date(NOW - HOUR) }));
    bed.requests.put(exportOf({ id: 'foreign', organizationId: OTHER_ORG }));

    const listed = await bed.list.execute(owner);

    expect(listed.map((request) => request.id)).toEqual(['new', 'old']);
  });
});

describe('downloading an export', () => {
  it('signs a link of five minutes that saves the archive under a readable name', async () => {
    const bed = testbed();
    const finished = exportOf();
    bed.requests.put(finished);

    const link = await bed.download.execute(owner, finished.id);

    expect(link.url).toContain(finished.objectKey);
    expect(link.expiresAt).toEqual(new Date(NOW + 5 * 60 * 1000));
    expect(bed.signed).toEqual([
      {
        key: finished.objectKey,
        options: { expiresInSeconds: 300, downloadName: 'social-media-poster-export-2026-10-17.zip' },
      },
    ]);
    expect(bed.requests.audit).toEqual([
      {
        organizationId: ORG,
        action: 'gdpr.export_downloaded',
        targetType: 'GdprRequest',
        targetId: finished.id,
      },
    ]);
  });

  it('refuses exports that run, expired, lost their archive or belong to another organization', async () => {
    const bed = testbed();
    bed.requests.put(exportOf({ id: 'running', status: 'RUNNING', completedAt: null, objectKey: null }));
    bed.requests.put(exportOf({ id: 'expired', expiresAt: new Date(NOW) }));
    bed.requests.put(exportOf({ id: 'cleared', objectKey: null }));
    bed.requests.put(exportOf({ id: 'foreign', organizationId: OTHER_ORG }));

    for (const id of ['running', 'expired', 'cleared', 'foreign', 'missing']) {
      await expect(bed.download.execute(owner, id)).rejects.toBeInstanceOf(DataExportUnavailableError);
    }
    expect(bed.signed).toEqual([]);
    expect(bed.requests.audit).toEqual([]);
  });
});
