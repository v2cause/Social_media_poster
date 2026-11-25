import type { Provider } from '@nestjs/common';
import {
  CompleteUpload,
  CreateDiagram,
  DeleteMedia,
  EntitlementsService,
  planMediaLimits,
  PrepareMediaDownload,
  RequestUpload,
  systemClock,
  UpdateMediaAltText,
  uuidV7Ids,
  type AiDependencies,
  type MediaDependencies,
  type PlanUsage,
  type StoragePort,
} from '@smp/core';
import { MediaReadModel, PrismaMediaUnitOfWork, type PrismaClient } from '@smp/db';
import { SharpImageProcessor, SvgDiagramRenderer } from '@smp/media';
import { MediaProducer } from '@smp/queue';

import { RequestOriginService } from '../../common/cls/tenant-context';
import { DATABASE_CLIENT, MEDIA_STORAGE } from '../../infrastructure/clients.module';
import { PLAN_USAGE } from '../billing/plan.module';
import { AI_DEPENDENCIES } from '../content/content.providers';

export const MEDIA_DEPENDENCIES = Symbol('MEDIA_DEPENDENCIES');
export const MEDIA_READ_MODEL = Symbol('MEDIA_READ_MODEL');

/** The use cases of the API side; media.process runs in the worker. */
type ApiMediaDependencies = Omit<MediaDependencies, 'processor'>;

const MEDIA_USE_CASES = [RequestUpload, CompleteUpload, UpdateMediaAltText, DeleteMedia] as const;

/** The media use cases of the core, wired to the adapters of the API (guide step 3.3). */
export const mediaProviders: Provider[] = [
  {
    provide: MEDIA_DEPENDENCIES,
    inject: [
      DATABASE_CLIENT,
      RequestOriginService,
      MEDIA_STORAGE,
      MediaProducer,
      EntitlementsService,
      PLAN_USAGE,
    ],
    useFactory: (
      base: PrismaClient,
      origin: RequestOriginService,
      storage: StoragePort,
      jobs: MediaProducer,
      entitlements: EntitlementsService,
      usage: PlanUsage,
    ): ApiMediaDependencies => ({
      unitOfWork: new PrismaMediaUnitOfWork(base, () => origin.get()),
      storage,
      jobs,
      // The originals of all workspaces of the organization, within its plan (guide step 7.4).
      limits: planMediaLimits(entitlements, usage),
      clock: systemClock,
      ids: uuidV7Ids,
    }),
  },
  {
    provide: MEDIA_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new MediaReadModel(base),
  },
  {
    // Renders the download once per asset in the API process, like the image for the alt text.
    provide: PrepareMediaDownload,
    inject: [MEDIA_DEPENDENCIES],
    useFactory: (deps: ApiMediaDependencies) =>
      new PrepareMediaDownload({ ...deps, processor: new SharpImageProcessor({ threads: 1 }) }),
  },
  {
    // Renders the SVG of the model in the API process; the AI rate limits bound it.
    provide: CreateDiagram,
    inject: [AI_DEPENDENCIES, MEDIA_DEPENDENCIES],
    useFactory: (ai: AiDependencies, deps: ApiMediaDependencies) =>
      new CreateDiagram(ai, deps, new SvgDiagramRenderer()),
  },
  ...MEDIA_USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [MEDIA_DEPENDENCIES],
    useFactory: (deps: ApiMediaDependencies) => new UseCase(deps),
  })),
];
