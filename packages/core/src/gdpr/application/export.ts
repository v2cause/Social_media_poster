import type { StoragePort } from '../../media/ports/storage';
import type { Clock } from '../../shared/ports/clock';
import { exportExpiryOf, exportKeyOf } from '../domain/request';
import type {
  ExportArchive,
  ExportArchives,
  ExportedOrganization,
  GdprNotifier,
  OrganizationDataSource,
} from '../ports/gdpr-runtime';
import type { GdprRequestRunner } from '../ports/gdpr-store';

// The export of an organization (guide step 8.1, ADR 0036): one ZIP archive in the object
// storage with a JSON file per table of the organization (data/<table>.json, secrets left out),
// the originals of its media library (media/<workspace>/<asset>-<file name>) and a manifest of
// what is inside. The owner who asked hears by email that it is ready; the archive is deleted
// after 24 hours.

/** The largest original the upload accepts, with room to spare. */
const MAX_ORIGINAL_BYTES = 25 * 1024 * 1024;
/** The version of the layout, for readers of older archives. */
const EXPORT_FORMAT = 1;
/** An export that waits or runs longer than this is given up; its job was lost or hangs. */
const EXPORT_TIMEOUT_HOURS = 12;
/** How many exports one tick expires. */
const EXPIRED_PER_TICK = 100;

const README = `This archive holds the data of one organization of Social Media Poster.

data/<table>.json     one JSON array per table, one object per row, times in UTC (ISO 8601)
media/<workspace>/    the originals of the media library as they were uploaded
manifest.json         the organization, the time of the export and how many rows each table has

Secrets such as the tokens of connected accounts and the hashes of invitations are left out.

Dieses Archiv enthält die Daten einer Organisation von Social Media Poster: eine JSON-Datei pro
Tabelle unter data/ (eine Zeile pro Objekt, Zeiten in UTC), die Originale der Medienbibliothek
unter media/ und eine Übersicht in manifest.json. Geheimnisse wie die Tokens verbundener Accounts
sind nicht enthalten.
`;

/** A name inside the archive: no folders, no control characters, not too long. */
export function archiveName(fileName: string): string {
  const cleaned = fileName
    .normalize('NFC')
    .replace(/\p{Cc}/gu, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

const encoder = new TextEncoder();

export interface ExportDependencies {
  requests: GdprRequestRunner;
  source: OrganizationDataSource;
  archives: ExportArchives;
  storage: Pick<StoragePort, 'head' | 'get' | 'delete'>;
  notifier: GdprNotifier;
  clock: Clock;
}

export interface ExportResult {
  outcome: 'exported' | 'skipped';
  tables?: number;
  rows?: number;
  mediaFiles?: number;
  bytes?: number;
}

export class ExportOrganizationData {
  constructor(private readonly deps: ExportDependencies) {}

  /** Runs one export; one that is not due, was given up or is no export is skipped. */
  async execute(requestId: string): Promise<ExportResult> {
    const { requests, source, archives, clock } = this.deps;
    const request = await requests.claim(requestId, clock.now());
    if (request?.kind !== 'EXPORT') {
      return { outcome: 'skipped' };
    }
    const organization = await source.organization(request.organizationId);
    if (!organization) {
      await requests.fail(request.id, clock.now(), { failure: 'ORGANIZATION_GONE' });
      return { outcome: 'skipped' };
    }
    const key = exportKeyOf(organization.id, request.id);
    const archive = archives.create(key);
    let written: Awaited<ReturnType<ExportOrganizationData['write']>>;
    let bytes: number;
    try {
      written = await this.write(archive, organization, request.createdAt);
      ({ bytes } = await archive.finish());
    } catch (error) {
      await archive.abort();
      throw error;
    }
    const completedAt = clock.now();
    const expiresAt = exportExpiryOf(completedAt);
    const completed = await requests.complete(request.id, completedAt, {
      objectKey: key,
      expiresAt,
      details: { ...written, bytes },
    });
    if (!completed) {
      // Given up while it ran: nobody may find the archive, so it goes.
      await this.deps.storage.delete(key);
      return { outcome: 'skipped' };
    }
    await this.deps.notifier.exportReady({
      requestId: request.id,
      organizationId: organization.id,
      requestedById: request.requestedById,
      expiresAt,
    });
    return { outcome: 'exported', ...written, bytes };
  }

  private async write(
    archive: ExportArchive,
    organization: ExportedOrganization,
    requestedAt: Date,
  ): Promise<{ tables: number; rows: number; mediaFiles: number; mediaMissing: number }> {
    const { source, storage } = this.deps;
    await archive.addFile('README.txt', encoder.encode(README));
    const counts: Record<string, number> = {};
    for (const table of source.tables()) {
      counts[table] = await archive.addJsonArray(`data/${table}.json`, source.rows(table, organization));
    }
    let mediaFiles = 0;
    let mediaMissing = 0;
    for await (const media of source.media(organization)) {
      // An original that is gone meanwhile does not stop the export; the manifest counts it.
      if (!(await storage.head(media.storageKey))) {
        mediaMissing += 1;
        continue;
      }
      const body = await storage.get(media.storageKey, { maxBytes: MAX_ORIGINAL_BYTES });
      await archive.addFile(
        `media/${archiveName(media.workspaceSlug)}/${media.assetId}-${archiveName(media.fileName)}`,
        body,
        { compress: false },
      );
      mediaFiles += 1;
    }
    const manifest = {
      format: EXPORT_FORMAT,
      organization: { id: organization.id, name: organization.name },
      workspaces: organization.workspaces,
      requestedAt: requestedAt.toISOString(),
      exportedAt: this.deps.clock.now().toISOString(),
      tables: counts,
      mediaFiles,
      mediaMissing,
    };
    await archive.addFile('manifest.json', encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`));
    const rows = Object.values(counts).reduce((sum, count) => sum + count, 0);
    return { tables: Object.keys(counts).length, rows, mediaFiles, mediaMissing };
  }
}

/**
 * Deletes the archives of exports that expired, and gives up exports that wait or run too long,
 * so that the owners can ask again (scheduler tick).
 */
export class ExpireExports {
  constructor(
    private readonly deps: {
      requests: Pick<GdprRequestRunner, 'expiredExports' | 'clearExport' | 'failStale'>;
      storage: Pick<StoragePort, 'delete'>;
      clock: Clock;
    },
  ) {}

  async execute(): Promise<{ exportsExpired: number; exportsTimedOut: number }> {
    const now = this.deps.clock.now();
    const expired = await this.deps.requests.expiredExports(now, EXPIRED_PER_TICK);
    for (const { id, objectKey } of expired) {
      await this.deps.storage.delete(objectKey);
      await this.deps.requests.clearExport(id);
    }
    const exportsTimedOut = await this.deps.requests.failStale(
      'EXPORT',
      new Date(now.getTime() - EXPORT_TIMEOUT_HOURS * 60 * 60 * 1000),
      now,
    );
    return { exportsExpired: expired.length, exportsTimedOut };
  }
}
