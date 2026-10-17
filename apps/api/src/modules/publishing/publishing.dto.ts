import {
  cancelVariantSchema,
  planResultSchema,
  publishNowSchema,
  resolveVariantSchema,
  retryVariantSchema,
  scheduleVariantSchema,
  variantListQuerySchema,
  variantPageSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of planning and publishing (guide steps 4.6 and 4.11). The schemas
// live in @smp/contracts, where the schedule bar and the calendar use them too.

export class ScheduleVariantDto extends createZodDto(scheduleVariantSchema) {}
export class CancelVariantDto extends createZodDto(cancelVariantSchema) {}
export class PublishNowDto extends createZodDto(publishNowSchema) {}
export class RetryVariantDto extends createZodDto(retryVariantSchema) {}
export class ResolveVariantDto extends createZodDto(resolveVariantSchema) {}
export class PlanResultDto extends createZodDto(planResultSchema) {}
export class VariantListQueryDto extends createZodDto(variantListQuerySchema) {}
export class VariantPageDto extends createZodDto(variantPageSchema) {}
