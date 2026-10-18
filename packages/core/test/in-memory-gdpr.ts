import type {
  AuditEntry,
  DeletableOrganization,
  DeletionBilling,
  ExportArchive,
  ExportArchives,
  ExportedMedia,
  ExportedOrganization,
  GdprJobs,
  GdprNotifier,
  GdprRequest,
  GdprRequestDetails,
  GdprRequestKind,
  GdprRequestRepository,
  GdprRequestRunner,
  GdprScope,
  GdprStore,
  GdprUnitOfWork,
  OrganizationDataSource,
  OrganizationDeletion,
  OrganizationEraser,
  SocialConnection,
} from '../src';

// In-memory stand-ins for the use cases of data protection (guide step 8.1): one table of
// requests behind the repository of the owners and the runner of the worker, an archive that
// keeps its files, and a data source with fixed tables.

const isOpenStatus = (request: GdprRequest): boolean =>
  request.status === 'PENDING' || request.status === 'RUNNING';

export class MemoryGdprRequests implements GdprRunnerAndRepository {
  readonly rows = new Map<string, GdprRequest>();
  readonly audit: AuditEntry[] = [];
  /** A parallel call that wins the race for the next create. */
  raceWith: GdprRequest | null = null;

  put(request: GdprRequest): void {
    this.rows.set(request.id, structuredClone(request));
  }

  get(id: string): GdprRequest | undefined {
    return this.rows.get(id);
  }

  create(request: GdprRequest): Promise<boolean> {
    if (this.raceWith) {
      this.put(this.raceWith);
      this.raceWith = null;
    }
    const conflict = [...this.rows.values()].some(
      (row) =>
        row.organizationId === request.organizationId && row.kind === request.kind && isOpenStatus(row),
    );
    if (conflict) {
      return Promise.resolve(false);
    }
    this.put(request);
    return Promise.resolve(true);
  }

  findOpen(organizationId: string, kind: GdprRequestKind): Promise<GdprRequest | null> {
    const open = [...this.rows.values()].find(
      (row) => row.organizationId === organizationId && row.kind === kind && isOpenStatus(row),
    );
    return Promise.resolve(open ? structuredClone(open) : null);
  }

  find(organizationId: string, requestId: string): Promise<GdprRequest | null> {
    const row = this.rows.get(requestId);
    return Promise.resolve(row?.organizationId === organizationId ? structuredClone(row) : null);
  }

  listRecent(organizationId: string, kind: GdprRequestKind, limit: number): Promise<GdprRequest[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.organizationId === organizationId && row.kind === kind)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit)
        .map((row) => structuredClone(row)),
    );
  }

  claim(requestId: string, at: Date): Promise<GdprRequest | null> {
    const row = this.rows.get(requestId);
    if (!row || !isOpenStatus(row) || row.runAfter.getTime() > at.getTime()) {
      return Promise.resolve(null);
    }
    row.status = 'RUNNING';
    row.startedAt = at;
    return Promise.resolve(structuredClone(row));
  }

  complete(
    requestId: string,
    at: Date,
    result: { details: GdprRequestDetails; objectKey?: string; expiresAt?: Date; anonymize?: boolean },
  ): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (row?.status !== 'RUNNING') {
      return Promise.resolve(false);
    }
    Object.assign(row, {
      status: 'COMPLETED',
      completedAt: at,
      details: result.details,
      objectKey: result.objectKey ?? null,
      expiresAt: result.expiresAt ?? null,
      ...(result.anonymize ? { requestedById: null } : {}),
    });
    return Promise.resolve(true);
  }

  cancel(organizationId: string, requestId: string, at: Date): Promise<boolean> {
    const row = this.rows.get(requestId);
    if (row?.organizationId !== organizationId || row.kind !== 'ERASURE' || row.status !== 'PENDING') {
      return Promise.resolve(false);
    }
    Object.assign(row, { status: 'CANCELED', completedAt: at });
    return Promise.resolve(true);
  }

  dueErasures(at: Date, stuckSince: Date, limit: number): Promise<string[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.kind === 'ERASURE' &&
            ((row.status === 'PENDING' && row.runAfter.getTime() <= at.getTime()) ||
              (row.status === 'RUNNING' && (row.startedAt?.getTime() ?? 0) <= stuckSince.getTime())),
        )
        .sort((a, b) => a.runAfter.getTime() - b.runAfter.getTime())
        .slice(0, limit)
        .map((row) => row.id),
    );
  }

  fail(requestId: string, at: Date, details: GdprRequestDetails): Promise<void> {
    const row = this.rows.get(requestId);
    if (row && isOpenStatus(row)) {
      Object.assign(row, { status: 'FAILED', completedAt: at, details: { ...row.details, ...details } });
    }
    return Promise.resolve();
  }

  failStale(kind: GdprRequestKind, createdBefore: Date, at: Date): Promise<number> {
    const stale = [...this.rows.values()].filter(
      (row) => row.kind === kind && isOpenStatus(row) && row.createdAt.getTime() < createdBefore.getTime(),
    );
    for (const row of stale) {
      Object.assign(row, {
        status: 'FAILED',
        completedAt: at,
        details: { ...row.details, failure: 'TIMEOUT' },
      });
    }
    return Promise.resolve(stale.length);
  }

  expiredExports(at: Date, limit: number): Promise<{ id: string; objectKey: string }[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (row) =>
            row.kind === 'EXPORT' &&
            row.objectKey !== null &&
            row.expiresAt !== null &&
            row.expiresAt.getTime() <= at.getTime(),
        )
        .sort((a, b) => (a.expiresAt?.getTime() ?? 0) - (b.expiresAt?.getTime() ?? 0))
        .slice(0, limit)
        .map((row) => ({ id: row.id, objectKey: row.objectKey ?? '' })),
    );
  }

  clearExport(requestId: string): Promise<void> {
    const row = this.rows.get(requestId);
    if (row) {
      row.objectKey = null;
    }
    return Promise.resolve();
  }
}

type GdprRunnerAndRepository = GdprRequestRepository & GdprRequestRunner;

/** The organizations that owners can delete, with their workspaces and their subscription. */
export class MemoryOrganizations implements OrganizationDeletion {
  readonly rows = new Map<string, DeletableOrganization>();

  put(organization: DeletableOrganization): void {
    this.rows.set(organization.id, { ...organization });
  }

  find(organizationId: string): Promise<DeletableOrganization | null> {
    const row = this.rows.get(organizationId);
    return Promise.resolve(row ? { ...row } : null);
  }

  markDeleted(organizationId: string, at: Date): Promise<void> {
    const row = this.rows.get(organizationId);
    if (row) {
      row.deletedAt = at;
    }
    return Promise.resolve();
  }

  restore(organizationId: string): Promise<void> {
    const row = this.rows.get(organizationId);
    if (row) {
      row.deletedAt = null;
    }
    return Promise.resolve();
  }
}

/** Runs the work against the shared tables; a failure leaves what the work wrote, like a test double. */
export class MemoryGdprUnitOfWork implements GdprUnitOfWork {
  readonly scopes: GdprScope[] = [];

  constructor(
    readonly requests: MemoryGdprRequests,
    readonly organizations: MemoryOrganizations = new MemoryOrganizations(),
  ) {}

  async run<T>(scope: GdprScope, work: (store: GdprStore) => Promise<T>): Promise<T> {
    this.scopes.push(scope);
    const audit: AuditEntry[] = [];
    const result = await work({
      requests: this.requests,
      organizations: this.organizations,
      audit: {
        record: (entry) => {
          audit.push(entry);
          return Promise.resolve();
        },
      },
    });
    // Like a commit: the audit entries of a failed unit of work are gone.
    this.requests.audit.push(...audit);
    return result;
  }
}

export class RecordingGdprJobs implements GdprJobs {
  readonly exports: string[] = [];
  readonly erasures: string[] = [];

  exportData(requestId: string): Promise<void> {
    this.exports.push(requestId);
    return Promise.resolve();
  }

  erase(requestId: string): Promise<void> {
    this.erasures.push(requestId);
    return Promise.resolve();
  }
}

export class RecordingGdprNotifier implements GdprNotifier {
  readonly ready: Parameters<GdprNotifier['exportReady']>[0][] = [];
  readonly scheduled: Parameters<GdprNotifier['erasureScheduled']>[0][] = [];
  /** Fails the next notice of an erasure, as a queue that is away would. */
  failNext = false;

  exportReady(notice: Parameters<GdprNotifier['exportReady']>[0]): Promise<void> {
    this.ready.push(notice);
    return Promise.resolve();
  }

  erasureScheduled(notice: Parameters<GdprNotifier['erasureScheduled']>[0]): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('queue away'));
    }
    this.scheduled.push(notice);
    return Promise.resolve();
  }
}

export class RecordingDeletionBilling implements DeletionBilling {
  readonly calls: { organizationId: string; end: boolean }[] = [];

  endWithPeriod(organizationId: string, end: boolean): Promise<void> {
    this.calls.push({ organizationId, end });
    return Promise.resolve();
  }
}

/** The rows of organizations as the erasure sees them: per table, the organization or workspace they name. */
export class MemoryEraser implements OrganizationEraser {
  readonly rows: { table: string; organizationId?: string; workspaceId?: string }[] = [];
  readonly connectionsOf = new Map<string, SocialConnection[]>();
  readonly customers = new Map<string, string>();
  /** Leaves the rows of this table behind, as a missing delete would. */
  forget: string | null = null;
  erasures = 0;

  connections(organizationId: string): Promise<SocialConnection[]> {
    return Promise.resolve(this.connectionsOf.get(organizationId) ?? []);
  }

  billingCustomerOf(organizationId: string): Promise<string | null> {
    return Promise.resolve(this.customers.get(organizationId) ?? null);
  }

  private matches(
    row: { organizationId?: string; workspaceId?: string },
    organizationId: string,
    workspaceIds: readonly string[],
  ) {
    return (
      row.organizationId === organizationId ||
      (row.workspaceId !== undefined && workspaceIds.includes(row.workspaceId))
    );
  }

  erase(organizationId: string, workspaceIds: readonly string[]): Promise<Record<string, number>> {
    this.erasures += 1;
    const counts: Record<string, number> = {};
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      const row = this.rows[index];
      if (row && this.matches(row, organizationId, workspaceIds) && row.table !== this.forget) {
        counts[row.table] = (counts[row.table] ?? 0) + 1;
        this.rows.splice(index, 1);
      }
    }
    this.connectionsOf.delete(organizationId);
    this.customers.delete(organizationId);
    return Promise.resolve(counts);
  }

  leftovers(organizationId: string, workspaceIds: readonly string[]): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const row of this.rows) {
      if (this.matches(row, organizationId, workspaceIds)) {
        counts[row.table] = (counts[row.table] ?? 0) + 1;
      }
    }
    return Promise.resolve(counts);
  }
}

/** An archive that keeps its files as text or bytes. */
export class MemoryArchive implements ExportArchive {
  readonly files = new Map<string, { body: Uint8Array; compress: boolean }>();
  finished = false;
  aborted = false;
  /** Throws on the file with this name, as a broken storage would. */
  failOn: string | null = null;

  constructor(readonly key: string) {}

  async addJsonArray(name: string, items: AsyncIterable<string>): Promise<number> {
    const values: string[] = [];
    for await (const item of items) {
      values.push(item);
    }
    await this.addFile(name, new TextEncoder().encode(`[${values.join(',')}]`));
    return values.length;
  }

  addFile(name: string, body: Uint8Array, options?: { compress?: boolean }): Promise<void> {
    if (name === this.failOn) {
      return Promise.reject(new Error(`storage refused ${name}`));
    }
    this.files.set(name, { body, compress: options?.compress ?? true });
    return Promise.resolve();
  }

  finish(): Promise<{ bytes: number }> {
    this.finished = true;
    return Promise.resolve({
      bytes: [...this.files.values()].reduce((sum, file) => sum + file.body.byteLength, 0),
    });
  }

  abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }

  text(name: string): string {
    const file = this.files.get(name);
    if (!file) {
      throw new Error(`no file ${name} in the archive`);
    }
    return new TextDecoder().decode(file.body);
  }

  json(name: string): unknown {
    return JSON.parse(this.text(name)) as unknown;
  }
}

export class MemoryArchives implements ExportArchives {
  readonly created: MemoryArchive[] = [];
  failOn: string | null = null;

  create(key: string): MemoryArchive {
    const archive = new MemoryArchive(key);
    archive.failOn = this.failOn;
    this.created.push(archive);
    return archive;
  }
}

/** A data source with fixed rows per table; the rows are serialized like the database does it. */
export class MemoryDataSource implements OrganizationDataSource {
  readonly organizations = new Map<string, ExportedOrganization>();
  readonly tableRows = new Map<string, Record<string, unknown>[]>();
  readonly mediaFiles: ExportedMedia[] = [];

  organization(organizationId: string): Promise<ExportedOrganization | null> {
    return Promise.resolve(this.organizations.get(organizationId) ?? null);
  }

  tables(): readonly string[] {
    return [...this.tableRows.keys()];
  }

  async *rows(table: string): AsyncIterable<string> {
    for (const row of this.tableRows.get(table) ?? []) {
      await Promise.resolve();
      yield JSON.stringify(row);
    }
  }

  async *media(): AsyncIterable<ExportedMedia> {
    for (const media of this.mediaFiles) {
      await Promise.resolve();
      yield media;
    }
  }
}
