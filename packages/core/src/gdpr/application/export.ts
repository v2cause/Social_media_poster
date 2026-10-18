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
// the checked originals of its media library (media/<workspace>/<asset>-<name>.<extension of
// their type>) and a manifest of what is inside. The owner who asked hears by email that it is
// ready; the archive is deleted after 24 hours.

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
media/<workspace>/    the originals of the media library that passed the checks of the upload,
                      named after the type of their content
manifest.json         the organization, the time of the export and how many rows each table has

Secrets such as the tokens of connected accounts and the hashes of invitations are left out.

Dieses Archiv enthält die Daten einer Organisation von Social Media Poster: eine JSON-Datei pro
Tabelle unter data/ (eine Zeile pro Objekt, Zeiten in UTC), die geprüften Originale der
Medienbibliothek unter media/, benannt nach dem Typ ihres Inhalts, und eine Übersicht in
manifest.json. Geheimnisse wie die Tokens verbundener Accounts sind nicht enthalten.
`;

/**
 * A name inside the archive: no folders, no control characters, not too long. Invisible format
 * characters go as well, so that a right-to-left override cannot show "gpj.exe" as "exe.jpg".
 */
export function archiveName(fileName: string): string {
  const cleaned = fileName
    .normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return (cleaned || 'file').slice(0, 120);
}

/** The extensions of the types the upload accepts. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * The name of an original inside the archive: the name the user gave it without its extension,
 * then the extension of the type its content showed (guide step 8.4). A JPEG called
 * "invoice.html" comes out as "invoice.jpg" and opens as an image, not in a browser.
 */
export function mediaArchiveName(fileName: string, mimeType: string | null): string {
  const extension = (mimeType === null ? undefined : EXTENSIONS[mimeType]) ?? 'bin';
  const base = archiveName(fileName).replace(/\.[a-z0-9]{1,10}$/i, '');
  return `${base || 'image'}.${extension}`;
}

const encoder = new TextEncoder();

export interface ExportDependencies {
  requests: GdprRequestRunner;
  source: OrganizationDataSource;
  archives: ExportArchives;
  storage: Pick<StoragePort, 'head' | 'get' | 'delete'>;
  notifier: Pick<GdprNotifier, 'exportReady'>;
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
        `media/${archiveName(media.workspaceSlug)}/${media.assetId}-${mediaArchiveName(media.fileName, media.mimeType)}`,
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
