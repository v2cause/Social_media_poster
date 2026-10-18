import type { ApplyRetention, RetentionReport, RewrapReport, RewrapSecrets } from '@smp/core';
import type { PrismaOutboxRelay } from '@smp/db';

// tick.maintenance (architecture 7.4), nightly: re-wraps the secrets of older keys after a key
// rotation (guide step 4.2), removes processed outbox events after a week and applies the
// retention periods (guide step 8.3, ADR 0038): the raw data of AI generations, processed webhook
// events, connection data and the metrics beyond the history of the plan. The rollups follow in
// the same tick; the media library is cleaned up by the hourly sweep of the role "gdpr".

export const OUTBOX_RETENTION_DAYS = 7;

export interface MaintenanceReport {
  secrets: RewrapReport;
  outboxPurged: number;
  retention: RetentionReport;
}

export class Maintenance {
  constructor(
    private readonly deps: {
      rewrapSecrets: RewrapSecrets;
      outbox: PrismaOutboxRelay;
      retention: Pick<ApplyRetention, 'execute'>;
    },
  ) {}

  async run(): Promise<MaintenanceReport> {
    const secrets = await this.deps.rewrapSecrets.execute();
    const outboxPurged = await this.deps.outbox.purgeProcessed(OUTBOX_RETENTION_DAYS);
    const retention = await this.deps.retention.execute();
    return { secrets, outboxPurged, retention };
  }
}
