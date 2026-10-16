import {
  cancelVariantSchema,
  planResultSchema,
  publishNowSchema,
  resolveVariantSchema,
  retryVariantSchema,
  scheduleVariantSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of planning and publishing (guide step 4.6). The schemas live in
// @smp/contracts, where the schedule bar and the calendar use them too.

export class ScheduleVariantDto extends createZodDto(scheduleVariantSchema) {}
export class CancelVariantDto extends createZodDto(cancelVariantSchema) {}
export class PublishNowDto extends createZodDto(publishNowSchema) {}
export class RetryVariantDto extends createZodDto(retryVariantSchema) {}
export class ResolveVariantDto extends createZodDto(resolveVariantSchema) {}
export class PlanResultDto extends createZodDto(planResultSchema) {}
