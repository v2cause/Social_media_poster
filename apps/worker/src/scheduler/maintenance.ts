import type { RewrapReport, RewrapSecrets } from '@smp/core';
import type { PrismaOutboxRelay } from '@smp/db';

// tick.maintenance (architecture 7.4), nightly: re-wraps the secrets of older keys after a key
// rotation (guide step 4.2) and removes processed outbox events after a week. The rollups and the
// clean-up of media follow with their phases.

export const OUTBOX_RETENTION_DAYS = 7;

export interface MaintenanceReport {
  secrets: RewrapReport;
  outboxPurged: number;
}

export class Maintenance {
  constructor(private readonly deps: { rewrapSecrets: RewrapSecrets; outbox: PrismaOutboxRelay }) {}

  async run(): Promise<MaintenanceReport> {
    const secrets = await this.deps.rewrapSecrets.execute();
    const outboxPurged = await this.deps.outbox.purgeProcessed(OUTBOX_RETENTION_DAYS);
    return { secrets, outboxPurged };
  }
}
