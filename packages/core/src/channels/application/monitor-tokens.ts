import type { Clock } from '../../shared/ports/clock';
import { accessExpiryOf } from '../domain/rules';
import { isNoticeDue, noticeStageOf, TOKEN_EXPIRY_WINDOW_MS } from '../domain/token-monitor';
import type {
  ExpiringConnection,
  ExpiringConnectionScanner,
  TokenMaintenanceUnitOfWork,
  TokenRefreshRequests,
} from '../ports/token-maintenance';

// tick.tokens, hourly (guide step 4.9): looks at the usable connections whose access runs out
// within 14 days. An active one gets the job token.refresh, which renews it where the platform
// allows it and marks it EXPIRING otherwise. An expiring one reminds its managers 14, 7 and 1 days
// ahead, once per stage. One whose access ran out needs a new grant: NEEDS_REAUTH, its scheduled
// variants are marked, and its managers hear of it. Each change runs in the tenant of its
// workspace, with its outbox event.

export interface TokenMonitorReport {
  checked: number;
  refreshRequested: number;
  reminded: number;
  expired: number;
  failed: number;
}

/** Connections per tick; the rest follow an hour later. */
const DEFAULT_BATCH_SIZE = 500;

export class MonitorTokens {
  constructor(
    private readonly deps: {
      scanner: ExpiringConnectionScanner;
      unitOfWork: TokenMaintenanceUnitOfWork;
      refreshes: TokenRefreshRequests;
      clock: Clock;
      batchSize?: number;
    },
  ) {}

  async execute(): Promise<TokenMonitorReport> {
    const now = this.deps.clock.now();
    const due = await this.deps.scanner.expiring(
      new Date(now.getTime() + TOKEN_EXPIRY_WINDOW_MS),
      this.deps.batchSize ?? DEFAULT_BATCH_SIZE,
    );
    const report: TokenMonitorReport = {
      checked: due.length,
      refreshRequested: 0,
      reminded: 0,
      expired: 0,
      failed: 0,
    };
    for (const connection of due) {
      try {
        if (connection.accessExpiresAt <= now) {
          report.expired += (await this.expire(connection, now)) ? 1 : 0;
        } else if (connection.status === 'ACTIVE') {
          if (connection.method !== 'BROWSER') {
            await this.deps.refreshes.request(connection);
            report.refreshRequested += 1;
          }
        } else {
          report.reminded += (await this.remind(connection, now)) ? 1 : 0;
        }
      } catch {
        // The next tick looks again.
        report.failed += 1;
      }
    }
    return report;
  }

  /** The access ran out: NEEDS_REAUTH, unless a new grant or a refresh came in meanwhile. */
  private expire(connection: ExpiringConnection, now: Date): Promise<boolean> {
    return this.deps.unitOfWork.run(connection, async (store) => {
      const current = await store.connections.find(connection.workspaceId, connection.connectionId);
      const expiry = current
        ? accessExpiryOf({
            hasRefreshToken: current.refreshTokenSealed !== null,
            accessTokenExpiresAt: current.accessTokenExpiresAt,
            refreshTokenExpiresAt: current.refreshTokenExpiresAt,
          })
        : null;
      if (expiry === null || expiry > now) {
        return false;
      }
      const mark = await store.connections.markNeedsReauth(
        connection.workspaceId,
        connection.connectionId,
        'EXPIRED',
      );
      if (mark.changed) {
        await store.outbox.add(connection.workspaceId, {
          type: 'notification.requested',
          payload: {
            type: 'reauth-required',
            connectionId: connection.connectionId,
            reason: 'EXPIRED',
            scheduledVariants: mark.scheduledVariants,
          },
        });
      }
      return mark.changed;
    });
  }

  /** The reminder of the stage the time left falls into, once. */
  private async remind(connection: ExpiringConnection, now: Date): Promise<boolean> {
    const stage = noticeStageOf(connection.accessExpiresAt, now);
    if (stage === null || !isNoticeDue(stage, connection.expiryNoticeDays)) {
      return false;
    }
    return this.deps.unitOfWork.run(connection, async (store) => {
      const noted = await store.connections.noteExpiryNotice(
        connection.workspaceId,
        connection.connectionId,
        stage,
        connection.expiryNoticeDays,
      );
      if (noted) {
        await store.outbox.add(connection.workspaceId, {
          type: 'notification.requested',
          payload: {
            type: 'token-expiring',
            connectionId: connection.connectionId,
            daysLeft: stage,
            expiresAt: connection.accessExpiresAt.toISOString(),
          },
        });
      }
      return noted;
    });
  }
}
