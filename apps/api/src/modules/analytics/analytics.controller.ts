import { Controller, Get, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { actorOf, refOf } from '../content/content.mappers';
import {
  AnalyticsAccountDto,
  AnalyticsBreakdownDto,
  AnalyticsBreakdownQueryDto,
  AnalyticsFilterDto,
  AnalyticsOverviewDto,
  AnalyticsPeriodQueryDto,
  AnalyticsPostDetailDto,
  AnalyticsTimeseriesDto,
  AnalyticsTimeseriesQueryDto,
  AnalyticsTopPostsDto,
  AnalyticsTopPostsQueryDto,
} from './analytics.dto';
import { AnalyticsService } from './analytics.service';
import { CSV_HEADER, csvLine, csvRow } from './csv';

const id = new ParseUUIDPipe();

/**
 * The analytics of a workspace (guide step 5.4): KPIs against the period before, series, top
 * posts, breakdowns, a post and an account, and the rollup as CSV. Periods are local days of the
 * workspace, limited by the analytics history of the plan.
 */
@ApiTags('analytics')
@WorkspaceScope()
@Controller('w/:ws/analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @RequirePermission('analytics.read')
  @ZodResponse({ type: AnalyticsOverviewDto })
  overview(
    @Access() access: RequestAccess,
    @Query() query: AnalyticsFilterDto,
  ): Promise<AnalyticsOverviewDto> {
    return this.analytics.overview(refOf(actorOf(access)), query);
  }

  @Get('timeseries')
  @RequirePermission('analytics.read')
  @ZodResponse({ type: AnalyticsTimeseriesDto })
  timeseries(
    @Access() access: RequestAccess,
    @Query() query: AnalyticsTimeseriesQueryDto,
  ): Promise<AnalyticsTimeseriesDto> {
    return this.analytics.timeseries(refOf(actorOf(access)), query);
  }

  @Get('top-posts')
  @RequirePermission('analytics.read')
  @ZodResponse({ type: AnalyticsTopPostsDto })
  topPosts(
    @Access() access: RequestAccess,
    @Query() query: AnalyticsTopPostsQueryDto,
  ): Promise<AnalyticsTopPostsDto> {
    return this.analytics.topPosts(refOf(actorOf(access)), query);
  }

  @Get('breakdown')
  @RequirePermission('analytics.read')
  @ZodResponse({ type: AnalyticsBreakdownDto })
  breakdown(
    @Access() access: RequestAccess,
    @Query() query: AnalyticsBreakdownQueryDto,
  ): Promise<AnalyticsBreakdownDto> {
    return this.analytics.breakdown(refOf(actorOf(access)), query);
  }

  @Get('posts/:variantId')
  @RequirePermission('analytics.read')
  @ZodResponse({ type: AnalyticsPostDetailDto })
  post(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
  ): Promise<AnalyticsPostDetailDto> {
    return this.analytics.post(refOf(actorOf(access)), variantId);
  }

  @Get('accounts/:accountId')
  @RequirePermission('analytics.read')
  @ZodResponse({ type: AnalyticsAccountDto })
  account(
    @Access() access: RequestAccess,
    @Param('accountId', id) accountId: string,
    @Query() query: AnalyticsPeriodQueryDto,
  ): Promise<AnalyticsAccountDto> {
    return this.analytics.account(refOf(actorOf(access)), accountId, query);
  }

  /** The rollup per account and day as CSV, streamed a batch at a time. */
  @Get('export.csv')
  @RequirePermission('analytics.read')
  @ApiOkResponse({
    description: 'One row per account and day.',
    content: { 'text/csv': { schema: { type: 'string' } } },
  })
  async export(
    @Access() access: RequestAccess,
    @Query() query: AnalyticsFilterDto,
    @Res() res: Response,
  ): Promise<void> {
    const ref = refOf(actorOf(access));
    // Errors of the period end here, before the first byte, as problem details.
    const { period } = await this.analytics.periodOf(ref, query);
    res.status(200);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="analytics-${period.from}-${period.to}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.write(csvLine([...CSV_HEADER]));
    try {
      for await (const rows of this.analytics.exportRows(ref, period, query)) {
        res.write(rows.map(csvRow).join(''));
      }
      res.end();
    } catch (error) {
      // The download breaks off instead of looking complete.
      res.destroy(error instanceof Error ? error : undefined);
    }
  }
}
