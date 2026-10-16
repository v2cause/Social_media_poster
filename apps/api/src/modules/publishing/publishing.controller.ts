import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CancelVariant,
  PublishNow,
  RescheduleVariant,
  ResolveNeedsAttention,
  RetryVariant,
  ScheduleVariant,
  VariantNotFoundError,
  type ContentActor,
  type PlanResult,
  type StoragePort,
} from '@smp/core';
import type { ContentReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { MEDIA_STORAGE } from '../../infrastructure/clients.module';
import { actorOf, refOf, toVariantDto } from '../content/content.mappers';
import {
  CancelVariantDto,
  PlanResultDto,
  PublishNowDto,
  ResolveVariantDto,
  RetryVariantDto,
  ScheduleVariantDto,
} from './publishing.dto';
import { PUBLISHING_READ_MODEL } from './publishing.providers';

const id = new ParseUUIDPipe();

/**
 * Planning a variant (guide step 4.6, architecture 7): plan, move, cancel, post now, try again,
 * and decide about an unclear publish. Times arrive as local date and time with their zone;
 * every answer carries the variant as it is now and the hints of the plan.
 */
@ApiTags('publishing')
@WorkspaceScope()
@Controller('w/:ws/variants')
export class PublishingController {
  constructor(
    @Inject(PUBLISHING_READ_MODEL) private readonly readModel: ContentReadModel,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
    private readonly scheduleVariant: ScheduleVariant,
    private readonly rescheduleVariant: RescheduleVariant,
    private readonly cancelVariant: CancelVariant,
    private readonly publishNow: PublishNow,
    private readonly retryVariant: RetryVariant,
    private readonly resolveNeedsAttention: ResolveNeedsAttention,
  ) {}

  @Post(':variantId/schedule')
  @RequirePermission('post.schedule')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PlanResultDto })
  async schedule(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: ScheduleVariantDto,
  ): Promise<PlanResultDto> {
    const actor = actorOf(access);
    const result = await this.scheduleVariant.execute({
      actor,
      variantId,
      version: body.version,
      at: { localDateTime: body.localDateTime, timeZone: body.timeZone },
      ...(body.socialAccountId ? { socialAccountId: body.socialAccountId } : {}),
    });
    return this.answer(actor, variantId, result);
  }

  @Post(':variantId/reschedule')
  @RequirePermission('post.schedule')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PlanResultDto })
  async reschedule(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: ScheduleVariantDto,
  ): Promise<PlanResultDto> {
    const actor = actorOf(access);
    const result = await this.rescheduleVariant.execute({
      actor,
      variantId,
      version: body.version,
      at: { localDateTime: body.localDateTime, timeZone: body.timeZone },
      ...(body.socialAccountId ? { socialAccountId: body.socialAccountId } : {}),
    });
    return this.answer(actor, variantId, result);
  }

  @Post(':variantId/cancel')
  @RequirePermission('post.schedule')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PlanResultDto })
  async cancel(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: CancelVariantDto,
  ): Promise<PlanResultDto> {
    const actor = actorOf(access);
    return this.answer(
      actor,
      variantId,
      await this.cancelVariant.execute({ actor, variantId, version: body.version }),
    );
  }

  @Post(':variantId/publish-now')
  @RequirePermission('post.publish')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PlanResultDto })
  async now(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: PublishNowDto,
  ): Promise<PlanResultDto> {
    const actor = actorOf(access);
    const result = await this.publishNow.execute({
      actor,
      variantId,
      version: body.version,
      timeZone: body.timeZone,
      ...(body.socialAccountId ? { socialAccountId: body.socialAccountId } : {}),
    });
    return this.answer(actor, variantId, result);
  }

  @Post(':variantId/retry')
  @RequirePermission('post.schedule')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PlanResultDto })
  async retry(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: RetryVariantDto,
  ): Promise<PlanResultDto> {
    const actor = actorOf(access);
    const result = await this.retryVariant.execute({
      actor,
      variantId,
      version: body.version,
      at:
        body.localDateTime === undefined
          ? { now: true, timeZone: body.timeZone }
          : { localDateTime: body.localDateTime, timeZone: body.timeZone },
    });
    return this.answer(actor, variantId, result);
  }

  @Post(':variantId/resolve')
  @RequirePermission('post.schedule')
  @HttpCode(200)
  @ZodResponse({ status: 200, type: PlanResultDto })
  async resolve(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: ResolveVariantDto,
  ): Promise<PlanResultDto> {
    const actor = actorOf(access);
    const result = await this.resolveNeedsAttention.execute({
      actor,
      variantId,
      version: body.version,
      action: body.action,
    });
    return this.answer(actor, variantId, result);
  }

  private async answer(actor: ContentActor, variantId: string, result: PlanResult): Promise<PlanResultDto> {
    const view = await this.readModel.variant(refOf(actor), variantId);
    if (!view) {
      throw new VariantNotFoundError();
    }
    return {
      variant: await toVariantDto(view, this.storage),
      status: result.status,
      warnings: result.warnings,
    };
  }
}
