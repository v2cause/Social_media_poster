import { Logger, type Provider } from '@nestjs/common';
import { aiEfforts, createAiProvider, PromptTokenEstimator, type AiLogger } from '@smp/ai';
import {
  CostCalculator,
  CreateBrandVoice,
  CreatePost,
  CreateStyle,
  DeletePost,
  fixedQuotaLimits,
  GenerateIdeas,
  GenerateVariants,
  QuotaService,
  RefineVariant,
  SetVariantMedia,
  systemClock,
  TestBrandVoice,
  UpdateBrandVoice,
  UpdateIdea,
  UpdatePost,
  UpdateStyle,
  UpdateVariant,
  uuidV7Ids,
  type AiDependencies,
  type AiProvider,
  type ContentDependencies,
} from '@smp/core';
import {
  ContentReadModel,
  PrismaAiGenerationLog,
  PrismaContentUnitOfWork,
  PrismaMediaUnitOfWork,
  PrismaPriceCatalog,
  PrismaQuotaStore,
  type PrismaClient,
} from '@smp/db';
import { MediaProducer } from '@smp/queue';

import { RequestOriginService } from '../../common/cls/tenant-context';
import type { ApiEnv } from '../../config/api-env';
import { API_ENV } from '../../config/config.module';
import { DATABASE_CLIENT } from '../../infrastructure/clients.module';
import { AI_RATE_LIMITS, AiRateLimiter, DEFAULT_AI_RATE_LIMITS } from './ai-rate-limiter';

export const CONTENT_DEPENDENCIES = Symbol('CONTENT_DEPENDENCIES');
export const AI_DEPENDENCIES = Symbol('AI_DEPENDENCIES');
export const AI_PROVIDER = Symbol('AI_PROVIDER');
export const CONTENT_READ_MODEL = Symbol('CONTENT_READ_MODEL');

const CONTENT_USE_CASES = [
  CreatePost,
  UpdatePost,
  DeletePost,
  UpdateVariant,
  CreateStyle,
  UpdateStyle,
  CreateBrandVoice,
  UpdateBrandVoice,
  UpdateIdea,
] as const;

const AI_USE_CASES = [GenerateVariants, RefineVariant, GenerateIdeas, TestBrandVoice] as const;

const logger = new Logger('ai');
// Fields only: prompts and answers never go to the logs (architecture 5.1).
const aiLogger: AiLogger = {
  info: (fields, message) => {
    logger.log(fields, message);
  },
  warn: (fields, message) => {
    logger.warn(fields, message);
  },
};

/** The use cases of the core, wired to the adapters of the API (guide step 2.7). */
export const contentProviders: Provider[] = [
  {
    // Refuses the mock in production: the API does not start (guide step 2.5).
    provide: AI_PROVIDER,
    inject: [API_ENV],
    useFactory: (env: ApiEnv): AiProvider =>
      createAiProvider(env, { nodeEnv: env.NODE_ENV, logger: aiLogger }),
  },
  {
    provide: CONTENT_DEPENDENCIES,
    inject: [DATABASE_CLIENT, RequestOriginService],
    useFactory: (base: PrismaClient, origin: RequestOriginService): ContentDependencies => ({
      unitOfWork: new PrismaContentUnitOfWork(base, () => origin.get()),
      clock: systemClock,
      ids: uuidV7Ids,
    }),
  },
  {
    provide: QuotaService,
    inject: [DATABASE_CLIENT, API_ENV],
    useFactory: (base: PrismaClient, env: ApiEnv) =>
      new QuotaService({
        store: new PrismaQuotaStore(base),
        limits: fixedQuotaLimits({ ai_micros: BigInt(env.AI_MONTHLY_CAP_MICROS) }),
        clock: systemClock,
      }),
  },
  {
    provide: AI_DEPENDENCIES,
    inject: [CONTENT_DEPENDENCIES, AI_PROVIDER, QuotaService, DATABASE_CLIENT, API_ENV],
    useFactory: (
      content: ContentDependencies,
      provider: AiProvider,
      quota: QuotaService,
      base: PrismaClient,
      env: ApiEnv,
    ): AiDependencies => ({
      unitOfWork: content.unitOfWork,
      provider,
      estimator: new PromptTokenEstimator(),
      quota,
      costs: new CostCalculator({ prices: new PrismaPriceCatalog(base), clock: systemClock }),
      log: new PrismaAiGenerationLog(base),
      clock: systemClock,
      ids: uuidV7Ids,
      model: env.AI_MODEL,
      efforts: aiEfforts(env),
      warn: (message, fields) => {
        logger.warn(fields, message);
      },
    }),
  },
  {
    provide: CONTENT_READ_MODEL,
    inject: [DATABASE_CLIENT],
    useFactory: (base: PrismaClient) => new ContentReadModel(base),
  },
  {
    // The media of a variant belong to the media context; the route sits with the variant.
    provide: SetVariantMedia,
    inject: [DATABASE_CLIENT, RequestOriginService, MediaProducer],
    useFactory: (base: PrismaClient, origin: RequestOriginService, jobs: MediaProducer) =>
      new SetVariantMedia({
        unitOfWork: new PrismaMediaUnitOfWork(base, () => origin.get()),
        jobs,
        ids: uuidV7Ids,
      }),
  },
  { provide: AI_RATE_LIMITS, useValue: DEFAULT_AI_RATE_LIMITS },
  AiRateLimiter,
  ...CONTENT_USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [CONTENT_DEPENDENCIES],
    useFactory: (deps: ContentDependencies) => new UseCase(deps),
  })),
  ...AI_USE_CASES.map((UseCase) => ({
    provide: UseCase,
    inject: [AI_DEPENDENCIES],
    useFactory: (deps: AiDependencies) => new UseCase(deps),
  })),
];
