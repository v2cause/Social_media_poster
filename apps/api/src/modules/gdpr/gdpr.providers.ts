import { Logger, type Provider } from '@nestjs/common';
import { StripeBillingGateway, type StripeClient } from '@smp/billing';
import {
  CancelOrganizationErasure,
  DownloadDataExport,
  ListDataExports,
  RequestDataExport,
  RequestOrganizationErasure,
  SubscriptionDeletionBilling,
  systemClock,
  uuidV7Ids,
  type DeletionDependencies,
  type GdprDependencies,
  type StoragePort,
} from '@smp/core';
import {
  PrismaBillingDirectory,
  PrismaGdprUnitOfWork,
  PrismaSubscriptionReader,
  type PrismaClient,
  type SystemPrismaClient,
} from '@smp/db';
import { GdprProducer, NotificationProducer } from '@smp/queue';

import { RequestOriginService } from '../../common/cls/tenant-context';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT, MEDIA_STORAGE, SYSTEM_DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { STRIPE_CLIENT } from '../billing/billing.providers';
import { EmailErasureNotifier } from './erasure-notifier';

// Data protection in the API (guide steps 8.1 and 8.2, ADR 0036 and 0037): the owners ask for an
// export as app_user in their organization and download a finished one with a link of a few
// minutes; the role "gdpr" of the worker writes the archive. An owner deletes the organization or
// takes the deletion back; with Stripe its subscription ends with the period or renews again, and
// every owner hears of the day of the erasure.

export const GDPR_DEPENDENCIES = Symbol('GDPR_DEPENDENCIES');
export const DELETION_DEPENDENCIES = Symbol('DELETION_DEPENDENCIES');

const logger = new Logger('OrganizationDeletion');

export const gdprProviders: Provider[] = [
  {
    provide: GDPR_DEPENDENCIES,
    inject: [DATABASE_CLIENT, RequestOriginService, GdprProducer],
    useFactory: (
      base: PrismaClient,
      origin: RequestOriginService,
      producer: GdprProducer,
    ): GdprDependencies => ({
      unitOfWork: new PrismaGdprUnitOfWork(base, () => origin.get()),
      jobs: {
        exportData: (requestId) => producer.exportData({ requestId }),
        erase: (requestId) => producer.erase({ requestId }),
      },
      clock: systemClock,
      ids: uuidV7Ids,
    }),
  },
  {
    provide: DELETION_DEPENDENCIES,
    inject: [
      API_ENV,
      DATABASE_CLIENT,
      SYSTEM_DATABASE_CLIENT,
      RequestOriginService,
      STRIPE_CLIENT,
      NotificationProducer,
    ],
    useFactory: (
      env: ApiEnv,
      base: PrismaClient,
      system: SystemPrismaClient,
      origin: RequestOriginService,
      stripe: StripeClient | null,
      notifications: NotificationProducer,
    ): DeletionDependencies => ({
      unitOfWork: new PrismaGdprUnitOfWork(base, () => origin.get()),
      billing: stripe
        ? new SubscriptionDeletionBilling({
            subscriptions: new PrismaSubscriptionReader(base),
            gateway: new StripeBillingGateway(stripe),
          })
        : null,
      notifier: new EmailErasureNotifier({
        directory: new PrismaBillingDirectory(system),
        notifications,
        appUrl: env.APP_URL.replace(/\/$/, ''),
      }),
      clock: systemClock,
      ids: uuidV7Ids,
      warn: (message, { error, ...fields }) => {
        logger.warn({ ...fields, err: error }, message);
      },
    }),
  },
  {
    provide: RequestOrganizationErasure,
    inject: [DELETION_DEPENDENCIES],
    useFactory: (deps: DeletionDependencies) => new RequestOrganizationErasure(deps),
  },
  {
    provide: CancelOrganizationErasure,
    inject: [DELETION_DEPENDENCIES],
    useFactory: (deps: DeletionDependencies) => new CancelOrganizationErasure(deps),
  },
  {
    provide: RequestDataExport,
    inject: [GDPR_DEPENDENCIES],
    useFactory: (deps: GdprDependencies) => new RequestDataExport(deps),
  },
  {
    provide: ListDataExports,
    inject: [GDPR_DEPENDENCIES],
    useFactory: (deps: GdprDependencies) => new ListDataExports(deps),
  },
  {
    provide: DownloadDataExport,
    inject: [GDPR_DEPENDENCIES, MEDIA_STORAGE],
    useFactory: (deps: GdprDependencies, storage: StoragePort) =>
      new DownloadDataExport({ unitOfWork: deps.unitOfWork, clock: deps.clock, storage }),
  },
];
