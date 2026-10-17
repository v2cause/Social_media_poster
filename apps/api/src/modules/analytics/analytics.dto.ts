import {
  analyticsAccountSchema,
  analyticsBreakdownQuerySchema,
  analyticsBreakdownSchema,
  analyticsFilterSchema,
  analyticsOverviewSchema,
  analyticsPeriodQuerySchema,
  analyticsPostDetailSchema,
  analyticsTimeseriesQuerySchema,
  analyticsTimeseriesSchema,
  analyticsTopPostsQuerySchema,
  analyticsTopPostsSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the analytics API (guide step 5.4). The schemas live in
// @smp/contracts, where the dashboard uses them too.

export class AnalyticsFilterDto extends createZodDto(analyticsFilterSchema) {}
export class AnalyticsOverviewDto extends createZodDto(analyticsOverviewSchema) {}
export class AnalyticsTimeseriesQueryDto extends createZodDto(analyticsTimeseriesQuerySchema) {}
export class AnalyticsTimeseriesDto extends createZodDto(analyticsTimeseriesSchema) {}
export class AnalyticsTopPostsQueryDto extends createZodDto(analyticsTopPostsQuerySchema) {}
export class AnalyticsTopPostsDto extends createZodDto(analyticsTopPostsSchema) {}
export class AnalyticsBreakdownQueryDto extends createZodDto(analyticsBreakdownQuerySchema) {}
export class AnalyticsBreakdownDto extends createZodDto(analyticsBreakdownSchema) {}
export class AnalyticsPostDetailDto extends createZodDto(analyticsPostDetailSchema) {}
export class AnalyticsPeriodQueryDto extends createZodDto(analyticsPeriodQuerySchema) {}
export class AnalyticsAccountDto extends createZodDto(analyticsAccountSchema) {}
