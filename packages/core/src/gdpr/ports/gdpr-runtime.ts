// What the worker role "gdpr" needs to export an organization (guide step 8.1, ADR 0036), all
// as app_system.

export interface ExportedOrganization {
  id: string;
  name: string;
  workspaces: { id: string; slug: string; name: string }[];
}

/** An original of the media library, as the export packs it. */
export interface ExportedMedia {
  workspaceSlug: string;
  assetId: string;
  fileName: string;
  storageKey: string;
}

/** The data of an organization, table by table, without secrets. */
export interface OrganizationDataSource {
  organization(organizationId: string): Promise<ExportedOrganization | null>;
  /** The tables the export holds, in a fixed order. */
  tables(): readonly string[];
  /**
   * The rows of one table that belong to the organization, page by page, each as one serialized
   * JSON object, so that large numbers keep every digit.
   */
  rows(table: string, organization: ExportedOrganization): AsyncIterable<string>;
  /** The originals of the media library. */
  media(organization: ExportedOrganization): AsyncIterable<ExportedMedia>;
}

/** An archive being written to the object storage. */
export interface ExportArchive {
  /** Adds a JSON array of serialized JSON values and returns how many there were. */
  addJsonArray(name: string, items: AsyncIterable<string>): Promise<number>;
  /** Adds a file; compress is false for files that are compressed already, such as images. */
  addFile(name: string, body: Uint8Array, options?: { compress?: boolean }): Promise<void>;
  /** Closes the archive and waits until it is stored. */
  finish(): Promise<{ bytes: number }>;
  /** Drops what was written so far. */
  abort(): Promise<void>;
}

export interface ExportArchives {
  create(key: string): ExportArchive;
}

/** What the owners hear about their requests. */
export interface GdprNotifier {
  /** To the owner who asked, or to every owner when that one is gone: until when it can be downloaded. */
  exportReady(notice: {
    requestId: string;
    organizationId: string;
    requestedById: string | null;
    expiresAt: Date;
  }): Promise<void>;
}
