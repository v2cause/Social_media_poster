import type { Clock } from '../../shared/ports/clock';
import { readOnlyReasonOf } from '../domain/subscription';
import type { BillingNotifier, ReadOnlyNotices } from '../ports/billing-store';

// The owners hear once when their organization became read-only (guide step 7.4): the end of the
// trial, of the grace period of an overdue payment, or of the subscription. A notice that could
// not be sent stays due for the next run; the notifier sends one email per moment and owner.

/** Organizations per run; the next run takes the rest. */
const NOTICES_PER_RUN = 200;

export class AnnounceReadOnly {
  constructor(
    private readonly deps: {
      notices: ReadOnlyNotices;
      notifier: Pick<BillingNotifier, 'readOnly'>;
      clock: Clock;
    },
  ) {}

  async execute(): Promise<{ announced: number; failed: number }> {
    const now = this.deps.clock.now();
    const due = await this.deps.notices.due(now, NOTICES_PER_RUN);
    let failed = 0;
    for (const { organizationId, status, readOnlyAt } of due) {
      try {
        await this.deps.notifier.readOnly({ organizationId, readOnlyAt, reason: readOnlyReasonOf(status) });
        await this.deps.notices.markSent(organizationId, readOnlyAt, now);
      } catch {
        failed += 1;
      }
    }
    return { announced: due.length - failed, failed };
  }
}
