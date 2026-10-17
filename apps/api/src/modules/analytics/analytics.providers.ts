import type { Provider } from '@nestjs/common';
import { EntitlementsService, planAnalyticsHistory, type AnalyticsHistory } from '@smp/core';
import { AnalyticsReadModel, type PrismaClient } from '@smp/db';

import { DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { AnalyticsService } from './analytics.service';
import { ANALYTICS_HISTORY, ANALYTICS_READ_MODEL } from './analytics.tokens';

/**
 * The reads of the analytics API (guide step 5.4) and the analytics history, the days the plan of
 * the organization keeps (guide step 7.4).
 */
export const analyticsProviders: Provider[] = [
  {
    provide: ANALYTICS_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new AnalyticsReadModel(base),
  },
  {
    provide: ANALYTICS_HISTORY,
    inject: [EntitlementsService],
    useFactory: (entitlements: EntitlementsService): AnalyticsHistory => planAnalyticsHistory(entitlements),
  },
  AnalyticsService,
];
