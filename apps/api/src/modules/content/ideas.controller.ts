import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { GenerateIdeas, IdeaNotFoundError, UpdateIdea } from '@smp/core';
import type { ContentReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { AiRateLimiter } from './ai-rate-limiter';
import {
  GenerateIdeasDto,
  GenerateIdeasResponseDto,
  IdeaDto,
  IdeaListDto,
  IdeaListQueryDto,
  UpdateIdeaDto,
} from './content.dto';
import { actorOf, refOf, toIdeaDto } from './content.mappers';
import { CONTENT_READ_MODEL } from './content.providers';

/** Topic ideas of a workspace (guide steps 2.7 and 2.9). */
@ApiTags('ideas')
@WorkspaceScope()
@Controller('w/:ws/ideas')
export class IdeasController {
  constructor(
    @Inject(CONTENT_READ_MODEL) private readonly readModel: ContentReadModel,
    private readonly generateIdeas: GenerateIdeas,
    private readonly updateIdea: UpdateIdea,
    private readonly rateLimiter: AiRateLimiter,
  ) {}

  @Get()
  @RequirePermission('idea.read')
  @ZodResponse({ type: IdeaListDto })
  async list(@Access() access: RequestAccess, @Query() query: IdeaListQueryDto): Promise<IdeaListDto> {
    const ideas = await this.readModel.ideas(
      refOf(actorOf(access)),
      query.status ? { status: query.status } : {},
    );
    return { ideas: ideas.map(toIdeaDto) };
  }

  /** New suggestions of the AI; counts against the AI quota and the rate limits. */
  @Post('generate')
  @RequirePermission('ai.use')
  @ZodResponse({ status: 201, type: GenerateIdeasResponseDto })
  async generate(
    @Access() access: RequestAccess,
    @Body() body: GenerateIdeasDto,
  ): Promise<GenerateIdeasResponseDto> {
    const actor = actorOf(access);
    const slot = await this.rateLimiter.acquire(actor);
    try {
      const result = await this.generateIdeas.execute({ actor, count: body.count });
      const ideas = await this.readModel.ideas(refOf(actor), { ids: result.ideaIds });
      return { ideas: ideas.map(toIdeaDto), duplicates: result.duplicates };
    } finally {
      await slot.release();
    }
  }

  @Patch(':ideaId')
  @RequirePermission('idea.write')
  @ZodResponse({ type: IdeaDto })
  async update(
    @Access() access: RequestAccess,
    @Param('ideaId', ParseUUIDPipe) ideaId: string,
    @Body() body: UpdateIdeaDto,
  ): Promise<IdeaDto> {
    const actor = actorOf(access);
    const { version, ...patch } = body;
    await this.updateIdea.execute({ actor, ideaId, version, patch });
    const [idea] = await this.readModel.ideas(refOf(actor), { ids: [ideaId] });
    if (!idea) {
      throw new IdeaNotFoundError();
    }
    return toIdeaDto(idea);
  }
}
