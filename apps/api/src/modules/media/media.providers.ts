import type { Provider } from '@nestjs/common';
import {
  CompleteUpload,
  DeleteMedia,
  RequestUpload,
  systemClock,
  UpdateMediaAltText,
  uuidV7Ids,
  type MediaDependencies,
  type StoragePort,
} from '@smp/core';
import { MediaReadModel, PrismaMediaUnitOfWork, type PrismaClient } from '@smp/db';
import { MediaProducer } from '@smp/queue';

import { RequestOriginService } from '../../common/cls/tenant-context';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT, MEDIA_STORAGE } from '../../infrastructure/clients.module';

export const MEDIA_DEPENDENCIES = Symbol('MEDIA_DEPENDENCIES');
export const MEDIA_READ_MODEL = Symbol('MEDIA_READ_MODEL');

/** The use cases of the API side; media.process runs in the worker. */
type ApiMediaDependencies = Omit<MediaDependencies, 'processor'>;

const MEDIA_USE_CASES = [RequestUpload, CompleteUpload, UpdateMediaAltText, DeleteMedia] as const;

/** The media use cases of the core, wired to the adapters of the API (guide step 3.3). */
export const mediaProviders: Provider[] = [
  {
    provide: MEDIA_DEPENDENCIES,
    inject: [DATABASE_CLIENT, RequestOriginService, MEDIA_STORAGE, MediaProducer, API_ENV],
    useFactory: (
      base: PrismaClient,
      origin: RequestOriginService,
      storage: StoragePort,
      jobs: MediaProducer,
      env: ApiEnv,
    ): ApiMediaDependencies => ({
      unitOfWork: new PrismaMediaUnitOfWork(base, () => origin.get()),
      storage,
      jobs,
      limits: { storageBytes: env.MEDIA_STORAGE_LIMIT_BYTES },
      clock: systemClock,
      ids: uuidV7Ids,
    }),
  },
  {
    provide: MEDIA_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new MediaReadModel(base),
  },
  ...MEDIA_USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [MEDIA_DEPENDENCIES],
    useFactory: (deps: ApiMediaDependencies) => new UseCase(deps),
  })),
];
