import type { Provider } from '@nestjs/common';
import {
  DownloadDataExport,
  ListDataExports,
  RequestDataExport,
  systemClock,
  uuidV7Ids,
  type GdprDependencies,
  type StoragePort,
} from '@smp/core';
import { PrismaGdprUnitOfWork, type PrismaClient } from '@smp/db';
import { GdprProducer } from '@smp/queue';

import { RequestOriginService } from '../../common/cls/tenant-context';
import { DATABASE_CLIENT, MEDIA_STORAGE } from '../../infrastructure/clients.module';

// Data protection in the API (guide step 8.1, ADR 0036): the owners ask for an export as
// app_user in their organization and download a finished one with a link of a few minutes; the
// role "gdpr" of the worker writes the archive.

export const GDPR_DEPENDENCIES = Symbol('GDPR_DEPENDENCIES');

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
