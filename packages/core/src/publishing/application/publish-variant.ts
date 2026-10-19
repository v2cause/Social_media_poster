import { isMissedWindow, isRunnable, LEASE_GRACE_MS, PUBLISH_LEASE_MS } from '../domain/publish-job';
import type { PublishJobStore, PublishJobVariant } from '../ports/publish-job';
import { PublishRun, readRunMedia } from './publish-run';
import {
  runReport,
  statusEvent,
  unitOfJob,
  type ClaimedRun,
  type PublishJobDependencies,
  type PublishJobInput,
  type PublishJobOutcome,
} from './publish-job-types';

// The publish job (guide step 4.8, architecture 7, steps 1 to 3): a job ends without action
// when its variant moved on, waits for the live lease of another run, fails a variant whose
// window it missed, and otherwise claims the variant with a lease by compare-and-swap and logs
// its attempt, in one transaction that also reads the account and the media of the run. Postgres
// decides, not the queue. The run itself follows in PublishRun.

export class PublishVariant {
  constructor(private readonly deps: PublishJobDependencies) {}

  async execute(job: PublishJobInput): Promise<PublishJobOutcome> {
    const claim = await unitOfJob(this.deps, job, (store) => this.claim(store, job));
    if (claim.kind === 'missed') {
      // Reported once the failure is committed, like the end of a run.
      const outcome: PublishJobOutcome = { kind: 'failed', code: 'MISSED_WINDOW' };
      const report = runReport(claim.variant, outcome, claim.at);
      if (report) {
        this.deps.observer?.runEnded(report);
      }
      return outcome;
    }
    if (claim.kind !== 'claimed') {
      return claim;
    }
    return new PublishRun(this.deps, job, claim.run).execute();
  }

  private async claim(
    store: PublishJobStore,
    job: PublishJobInput,
  ): Promise<
    | { kind: 'claimed'; run: ClaimedRun }
    | { kind: 'missed'; variant: PublishJobVariant; at: Date }
    | PublishJobOutcome
  > {
    const variant = await store.variants.lockForJob(job.workspaceId, job.variantId);
    if (!variant) {
      return { kind: 'skipped', reason: 'NOT_FOUND' };
    }
    if (variant.scheduleVersion !== job.scheduleVersion || !isRunnable(variant.status)) {
      return { kind: 'skipped', reason: 'STALE' };
    }
    const now = this.deps.clock.now();
    if (
      variant.status === 'PUBLISHING' &&
      variant.leaseOwner !== job.owner &&
      variant.leaseUntil !== null &&
      variant.leaseUntil > now
    ) {
      return { kind: 'busy', retryInMs: variant.leaseUntil.getTime() - now.getTime() + LEASE_GRACE_MS };
    }
    if (isMissedWindow(variant, job.trigger, now)) {
      if (!(await store.variants.fail(job.workspaceId, variant.id, variant.version, 'MISSED_WINDOW'))) {
        return { kind: 'skipped', reason: 'STALE' };
      }
      await store.outbox.add(job.workspaceId, statusEvent(variant, 'FAILED'));
      await store.outbox.add(job.workspaceId, {
        type: 'notification.requested',
        payload: { type: 'publish-failed', variantId: variant.id, failureCode: 'MISSED_WINDOW' },
      });
      return { kind: 'missed', variant, at: now };
    }

    const lease = {
      owner: job.owner,
      until: new Date(now.getTime() + (this.deps.leaseMs ?? PUBLISH_LEASE_MS)),
    };
    const version = await store.variants.claim(job.workspaceId, variant.id, variant.version, lease);
    if (version === null) {
      return { kind: 'skipped', reason: 'STALE' };
    }
    const unclear = await store.attempts.unclear(job.workspaceId, variant.id);
    const attemptId = this.deps.ids.newId();
    await store.attempts.start({
      id: attemptId,
      workspaceId: job.workspaceId,
      variantId: variant.id,
      scheduleVersion: variant.scheduleVersion,
      trigger: job.trigger,
      leaseOwner: job.owner,
      startedAt: now,
    });
    // A run that takes over an expired lease does not announce PUBLISHING again.
    if (variant.status !== 'PUBLISHING') {
      await store.outbox.add(job.workspaceId, statusEvent(variant, 'PUBLISHING'));
    }
    // What the run sends to and with, read in this transaction instead of one of its own.
    const target =
      variant.socialAccountId === null
        ? null
        : await store.targets.find(job.workspaceId, variant.socialAccountId);
    const media = await readRunMedia(store, variant);
    return { kind: 'claimed', run: { variant, version, attemptId, startedAt: now, unclear, target, media } };
  }
}
