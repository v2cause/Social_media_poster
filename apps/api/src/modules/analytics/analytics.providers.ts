import type { Provider } from '@nestjs/common';
import { fixedAnalyticsHistory, type AnalyticsHistory } from '@smp/core';
import { AnalyticsReadModel, type PrismaClient } from '@smp/db';

import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { AnalyticsService } from './analytics.service';
import { ANALYTICS_HISTORY, ANALYTICS_READ_MODEL } from './analytics.tokens';

/**
 * The reads of the analytics API (guide step 5.4) and the analytics history: the same number of
 * days for every organization (ANALYTICS_HISTORY_DAYS) until plans set it (phase 7).
 */
export const analyticsProviders: Provider[] = [
  {
    provide: ANALYTICS_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new AnalyticsReadModel(base),
  },
  {
    provide: ANALYTICS_HISTORY,
    inject: [API_ENV],
    useFactory: (env: ApiEnv): AnalyticsHistory => fixedAnalyticsHistory(env.ANALYTICS_HISTORY_DAYS),
  },
  AnalyticsService,
];
