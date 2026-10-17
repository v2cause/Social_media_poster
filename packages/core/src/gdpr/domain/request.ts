// Data protection of an organization (guide steps 8.1 and 8.2, ADR 0036). An export packs all
// data of the organization into one archive in the object storage; the owners download it on the
// data page of the organization for 24 hours, then it is deleted. The erasure of an organization
// uses the same requests (guide step 8.2).

export const GDPR_REQUEST_KINDS = ['EXPORT', 'ERASURE'] as const;
export type GdprRequestKind = (typeof GDPR_REQUEST_KINDS)[number];

export const GDPR_REQUEST_STATUSES = ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELED'] as const;
export type GdprRequestStatus = (typeof GDPR_REQUEST_STATUSES)[number];

/** Counts and codes of a run; never personal data. */
export type GdprRequestDetails = Readonly<Record<string, string | number | boolean>>;

export interface GdprRequest {
  id: string;
  organizationId: string;
  kind: GdprRequestKind;
  status: GdprRequestStatus;
  /** The owner who asked; null once that user is gone. */
  requestedById: string | null;
  /** The request is not run before this moment. */
  runAfter: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** The archive of an export in the object storage, while it exists. */
  objectKey: string | null;
  /** Until when the archive of an export exists. */
  expiresAt: Date | null;
  details: GdprRequestDetails;
  createdAt: Date;
}

/** How long the archive of an export can be downloaded before it is deleted. */
export const EXPORT_AVAILABLE_HOURS = 24;
/** How long one download link lasts; the data page creates a new one for every download. */
export const DOWNLOAD_LINK_SECONDS = 5 * 60;

export const exportExpiryOf = (completedAt: Date): Date =>
  new Date(completedAt.getTime() + EXPORT_AVAILABLE_HOURS * 60 * 60 * 1000);

/** The archive of an export: under the organization, so that its erasure finds it. */
export const exportKeyOf = (organizationId: string, requestId: string): string =>
  `exports/${organizationId}/${requestId}.zip`;

/** Every archive of an organization. */
export const exportPrefixOf = (organizationId: string): string => `exports/${organizationId}/`;

/** The name the browser saves an archive under, with the day of the export in UTC. */
export const exportFileNameOf = (completedAt: Date): string =>
  `social-media-poster-export-${completedAt.toISOString().slice(0, 10)}.zip`;

/** A request that has not finished: waiting or running. */
export const isOpen = (request: Pick<GdprRequest, 'status'>): boolean =>
  request.status === 'PENDING' || request.status === 'RUNNING';

/** An export whose archive exists and has not expired. */
export const isDownloadable = (
  request: Pick<GdprRequest, 'kind' | 'status' | 'objectKey' | 'expiresAt'>,
  at: Date,
): boolean =>
  request.kind === 'EXPORT' &&
  request.status === 'COMPLETED' &&
  request.objectKey !== null &&
  request.expiresAt !== null &&
  request.expiresAt.getTime() > at.getTime();
