import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GenerateVariants, RefineVariant, SuggestAltText } from '@smp/core';
import type { Response } from 'express';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { AiRateLimiter } from './ai-rate-limiter';
import {
  AltTextSuggestionDto,
  GenerateVariantsDto,
  RefineVariantDto,
  SuggestAltTextDto,
} from './content.dto';
import { actorOf } from './content.mappers';
import { streamEvents } from './sse';

const EVENT_STREAM = {
  description:
    'Server-sent events: generation.started, variant.partial, variant.reset, generation.completed or generation.failed (schema generationEventSchema in @smp/contracts).',
  content: { 'text/event-stream': { schema: { type: 'string' } } },
} as const;

/** AI generation and refinement as server-sent events over POST (guide step 2.7). */
@ApiTags('ai')
@WorkspaceScope()
@Controller('w/:ws/ai')
export class AiController {
  constructor(
    private readonly generateVariants: GenerateVariants,
    private readonly refineVariant: RefineVariant,
    private readonly suggestAltText: SuggestAltText,
    private readonly rateLimiter: AiRateLimiter,
  ) {}

  /**
   * A suggested alt text for an image (guide step 3.5). Counts against the AI quota and the rate
   * limits; the user confirms the suggestion, nothing is saved here.
   */
  @Post('alt-texts')
  @RequirePermission('ai.use')
  @ZodResponse({ status: 200, type: AltTextSuggestionDto })
  async altText(
    @Access() access: RequestAccess,
    @Body() body: SuggestAltTextDto,
  ): Promise<AltTextSuggestionDto> {
    const actor = actorOf(access);
    const slot = await this.rateLimiter.acquire(actor);
    try {
      const altText = await this.suggestAltText.execute({
        actor,
        assetId: body.assetId,
        ...(body.language ? { language: body.language } : {}),
        ...(body.context ? { context: body.context } : {}),
      });
      return { altText };
    } finally {
      await slot.release();
    }
  }

  @Post('generations')
  @RequirePermission('ai.use')
  @ApiOkResponse(EVENT_STREAM)
  async generate(
    @Access() access: RequestAccess,
    @Body() body: GenerateVariantsDto,
    @Res() res: Response,
  ): Promise<void> {
    const actor = actorOf(access);
    const slot = await this.rateLimiter.acquire(actor);
    try {
      const abort = new AbortController();
      const events = this.generateVariants.execute({
        actor,
        postId: body.postId,
        ...(body.variantIds ? { variantIds: body.variantIds } : {}),
        signal: abort.signal,
      });
      await streamEvents(res, events, abort);
    } finally {
      await slot.release();
    }
  }

  @Post('refinements')
  @RequirePermission('ai.use')
  @ApiOkResponse(EVENT_STREAM)
  async refine(
    @Access() access: RequestAccess,
    @Body() body: RefineVariantDto,
    @Res() res: Response,
  ): Promise<void> {
    const actor = actorOf(access);
    const slot = await this.rateLimiter.acquire(actor);
    try {
      const abort = new AbortController();
      const events = this.refineVariant.execute({
        actor,
        variantId: body.variantId,
        action: body.action,
        instruction: body.instruction ?? null,
        language: body.language ?? null,
        current: body.current,
        signal: abort.signal,
      });
      await streamEvents(res, events, abort);
    } finally {
      await slot.release();
    }
  }
}
