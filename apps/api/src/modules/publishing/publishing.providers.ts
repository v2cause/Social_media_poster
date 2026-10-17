import type { Provider } from '@nestjs/common';
import {
  CancelVariant,
  PublishNow,
  RescheduleVariant,
  ResolveNeedsAttention,
  RetryVariant,
  ScheduleVariant,
  systemClock,
  type PublishingDependencies,
} from '@smp/core';
import {
  ContentReadModel,
  PrismaPublishingUnitOfWork,
  VariantListReadModel,
  type PrismaClient,
} from '@smp/db';

import { RequestOriginService } from '../../common/cls/tenant-context';
import { DATABASE_CLIENT } from '../../infrastructure/clients.module';

export const PUBLISHING_DEPENDENCIES = Symbol('PUBLISHING_DEPENDENCIES');
export const PUBLISHING_READ_MODEL = Symbol('PUBLISHING_READ_MODEL');
export const VARIANT_LIST_READ_MODEL = Symbol('VARIANT_LIST_READ_MODEL');

const PUBLISHING_USE_CASES = [
  ScheduleVariant,
  RescheduleVariant,
  CancelVariant,
  PublishNow,
  RetryVariant,
  ResolveNeedsAttention,
] as const;

/**
 * The planning use cases of the core, wired to the adapters of the API (guide step 4.6), and the
 * list of the variants for the calendar and the post list (guide step 4.11).
 */
export const publishingProviders: Provider[] = [
  {
    provide: PUBLISHING_DEPENDENCIES,
    inject: [DATABASE_CLIENT, RequestOriginService],
    useFactory: (base: PrismaClient, origin: RequestOriginService): PublishingDependencies => ({
      unitOfWork: new PrismaPublishingUnitOfWork(base, () => origin.get()),
      clock: systemClock,
    }),
  },
  {
    provide: PUBLISHING_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new ContentReadModel(base),
  },
  {
    provide: VARIANT_LIST_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new VariantListReadModel(base),
  },
  ...PUBLISHING_USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [PUBLISHING_DEPENDENCIES],
    useFactory: (deps: PublishingDependencies) => new UseCase(deps),
  })),
];
