import type { AdapterLogger } from '../../channels/ports/platform-adapter';
import type { SecretSealer } from '../../channels/ports/secrets';
import type { AdapterResolver, ConnectionLock } from '../../channels/ports/token-maintenance';
import type { VariantStatus } from '../../content/domain/types';
import type { StoragePort } from '../../media/ports/storage';
import type { OutboxEventInput } from '../../shared/domain/outbox';
import type { Clock } from '../../shared/ports/clock';
import type { IdGenerator } from '../../shared/ports/ids';
import type { PublishFailureCode } from '../domain/publish-job';
import type {
  OperationPrices,
  PublishJobStore,
  PublishJobTarget,
  PublishJobTrigger,
  PublishJobUnitOfWork,
  PublishJobVariant,
  PublishMediaItem,
  PublishRendition,
  UnclearAttempt,
} from '../ports/publish-job';

// What the parts of the publish job share (guide step 4.8): its dependencies, the job, the
// outcome the queue acts on, and the claimed run.

export interface PublishJobDependencies {
  unitOfWork: PublishJobUnitOfWork;
  adapters: AdapterResolver;
  /** Opens and seals tokens with the token keyring. */
  sealer: SecretSealer;
  locks: ConnectionLock;
  storage: Pick<StoragePort, 'signedGetUrl'>;
  prices: OperationPrices;
  /** SHA-256 in hex. */
  hash: (value: string) => string;
  clock: Clock;
  ids: IdGenerator;
  logger: AdapterLogger;
  /** PUBLISH_DRY_RUN: the live adapters send nothing; the mock adapters still do. */
  dryRunLive: boolean;
  /** How long a lease lasts; 5 minutes by default. */
  leaseMs?: number;
  /** ANALYTICS_CADENCE_SCALE for the first metrics poll of a published post; 1 by default. */
  metricsCadenceScale?: number;
}

export interface PublishJobInput {
  organizationId: string;
  workspaceId: string;
  variantId: string;
  scheduleVersion: number;
  trigger: PublishJobTrigger;
  /** No automatic attempt follows a failure of this run. */
  lastAttempt: boolean;
  /** Unique per run, for example the lock token of the queue. */
  owner: string;
  /** Aborted when the worker stops at once; the run then writes nothing more, like a crashed one. */
  signal: AbortSignal;
}

export type PublishJobOutcome =
  | { kind: 'skipped'; reason: 'NOT_FOUND' | 'STALE' | 'LEASE_LOST' }
  /** Another run holds a live lease; try again after it. */
  | { kind: 'busy'; retryInMs: number }
  | { kind: 'published'; reconciled: boolean; dryRun: boolean }
  /**
   * RETRYING. countsAsAttempt false: wait retryAfterMs without using up an attempt (rate limit);
   * otherwise the backoff of the queue applies, at least retryAfterMs.
   */
  | { kind: 'retry'; code: PublishFailureCode; retryAfterMs: number | null; countsAsAttempt: boolean }
  | { kind: 'failed'; code: PublishFailureCode }
  | { kind: 'needs_attention'; code: PublishFailureCode };

/** An image of the variant with the rendition its platform gets; null while it is being made. */
export interface RunMedia {
  item: PublishMediaItem;
  rendition: PublishRendition | null;
}

/**
 * A run after its claim: the variant as it was claimed, the attempt it logged, and what the run
 * sends to and with, read in the transaction of the claim (guide step 8.5: one transaction
 * less per run).
 */
export interface ClaimedRun {
  variant: PublishJobVariant;
  /** The version of the variant after the claim. */
  version: number;
  attemptId: string;
  startedAt: Date;
  /** The open attempts before this one. */
  unclear: UnclearAttempt[];
  /** The account with its connection; null when the variant has no account or it is gone. */
  target: PublishJobTarget | null;
  media: RunMedia[];
}

export const statusEvent = (variant: PublishJobVariant, status: VariantStatus): OutboxEventInput => ({
  type: 'variant.status',
  payload: {
    variantId: variant.id,
    postId: variant.postId,
    status,
    scheduleVersion: variant.scheduleVersion,
  },
});

/** A unit of work in the tenant of the job. A stopped run touches the database no more. */
export function unitOfJob<T>(
  deps: Pick<PublishJobDependencies, 'unitOfWork'>,
  job: PublishJobInput,
  work: (store: PublishJobStore) => Promise<T>,
): Promise<T> {
  job.signal.throwIfAborted();
  return deps.unitOfWork.run({ organizationId: job.organizationId, workspaceId: job.workspaceId }, work);
}
