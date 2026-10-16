import { Body, Controller, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  BrandVoiceNotFoundError,
  CreateBrandVoice,
  CreateStyle,
  StyleNotFoundError,
  TestBrandVoice,
  UpdateBrandVoice,
  UpdateStyle,
  type ContentActor,
} from '@smp/core';
import type { ContentReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import { RequirePermission, WorkspaceScope } from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { AiRateLimiter } from './ai-rate-limiter';
import {
  BrandVoiceDto,
  BrandVoiceListDto,
  BrandVoiceListQueryDto,
  BrandVoiceTestResponseDto,
  BrandVoiceVersionListDto,
  CreateBrandVoiceDto,
  CreateStyleDto,
  StyleDto,
  StyleListDto,
  TestBrandVoiceDto,
  UpdateBrandVoiceDto,
  UpdateStyleDto,
} from './content.dto';
import { actorOf, refOf, toBrandVoiceDto } from './content.mappers';
import { CONTENT_READ_MODEL } from './content.providers';

const id = new ParseUUIDPipe();

/** Style presets and the custom styles of a workspace (guide steps 2.7 and 2.9). */
@ApiTags('styles')
@WorkspaceScope()
@Controller('w/:ws/styles')
export class StylesController {
  constructor(
    @Inject(CONTENT_READ_MODEL) private readonly readModel: ContentReadModel,
    private readonly createStyle: CreateStyle,
    private readonly updateStyle: UpdateStyle,
  ) {}

  /** Presets first, then the custom styles in their order; inactive ones included. */
  @Get()
  @RequirePermission('post.read')
  @ZodResponse({ type: StyleListDto })
  async list(@Access() access: RequestAccess): Promise<StyleListDto> {
    return { styles: await this.readModel.styles(refOf(actorOf(access))) };
  }

  @Post()
  @RequirePermission('brand_voice.manage')
  @ZodResponse({ status: 201, type: StyleDto })
  async create(@Access() access: RequestAccess, @Body() body: CreateStyleDto): Promise<StyleDto> {
    const actor = actorOf(access);
    const { styleId } = await this.createStyle.execute({
      actor,
      name: body.name,
      instructions: body.instructions,
    });
    return this.load(actor, styleId);
  }

  @Patch(':styleId')
  @RequirePermission('brand_voice.manage')
  @ZodResponse({ type: StyleDto })
  async update(
    @Access() access: RequestAccess,
    @Param('styleId', id) styleId: string,
    @Body() body: UpdateStyleDto,
  ): Promise<StyleDto> {
    const actor = actorOf(access);
    const { version, ...patch } = body;
    await this.updateStyle.execute({ actor, styleId, version, patch });
    return this.load(actor, styleId);
  }

  private async load(actor: ContentActor, styleId: string): Promise<StyleDto> {
    const style = (await this.readModel.styles(refOf(actor))).find((candidate) => candidate.id === styleId);
    if (!style) {
      throw new StyleNotFoundError();
    }
    return style;
  }
}

/** Brand voices with their immutable versions and the voice test (guide steps 2.7 and 2.9). */
@ApiTags('brand-voices')
@WorkspaceScope()
@Controller('w/:ws/brand-voices')
export class BrandVoicesController {
  constructor(
    @Inject(CONTENT_READ_MODEL) private readonly readModel: ContentReadModel,
    private readonly createBrandVoice: CreateBrandVoice,
    private readonly updateBrandVoice: UpdateBrandVoice,
    private readonly testBrandVoice: TestBrandVoice,
    private readonly rateLimiter: AiRateLimiter,
  ) {}

  /** The voices with their current content; archived ones only on request. */
  @Get()
  @RequirePermission('post.read')
  @ZodResponse({ type: BrandVoiceListDto })
  async list(
    @Access() access: RequestAccess,
    @Query() query: BrandVoiceListQueryDto,
  ): Promise<BrandVoiceListDto> {
    const voices = await this.readModel.brandVoices(refOf(actorOf(access)), {
      includeArchived: query.archived,
    });
    return { brandVoices: voices.map(toBrandVoiceDto) };
  }

  @Post()
  @RequirePermission('brand_voice.manage')
  @ZodResponse({ status: 201, type: BrandVoiceDto })
  async create(@Access() access: RequestAccess, @Body() body: CreateBrandVoiceDto): Promise<BrandVoiceDto> {
    const actor = actorOf(access);
    const { brandVoiceId } = await this.createBrandVoice.execute({
      actor,
      content: body.content,
      isDefault: body.isDefault,
    });
    return this.load(actor, brandVoiceId);
  }

  @Patch(':brandVoiceId')
  @RequirePermission('brand_voice.manage')
  @ZodResponse({ type: BrandVoiceDto })
  async update(
    @Access() access: RequestAccess,
    @Param('brandVoiceId', id) brandVoiceId: string,
    @Body() body: UpdateBrandVoiceDto,
  ): Promise<BrandVoiceDto> {
    const actor = actorOf(access);
    await this.updateBrandVoice.execute({
      actor,
      brandVoiceId,
      version: body.version,
      ...(body.content ? { content: body.content } : {}),
      ...(body.isDefault === undefined ? {} : { isDefault: body.isDefault }),
      ...(body.archived === undefined ? {} : { archived: body.archived }),
    });
    return this.load(actor, brandVoiceId);
  }

  @Get(':brandVoiceId/versions')
  @RequirePermission('post.read')
  @ZodResponse({ type: BrandVoiceVersionListDto })
  async versions(
    @Access() access: RequestAccess,
    @Param('brandVoiceId', id) brandVoiceId: string,
  ): Promise<BrandVoiceVersionListDto> {
    const versions = await this.readModel.brandVoiceVersions(refOf(actorOf(access)), brandVoiceId);
    if (!versions) {
      throw new BrandVoiceNotFoundError();
    }
    return {
      versions: versions.map((version) => ({ ...version, createdAt: version.createdAt.toISOString() })),
    };
  }

  /** A sample post in the voice; counts against the AI quota and the rate limits. */
  @Post(':brandVoiceId/test')
  @RequirePermission('brand_voice.manage')
  @ZodResponse({ status: 201, type: BrandVoiceTestResponseDto })
  async test(
    @Access() access: RequestAccess,
    @Param('brandVoiceId', id) brandVoiceId: string,
    @Body() body: TestBrandVoiceDto,
  ): Promise<BrandVoiceTestResponseDto> {
    const actor = actorOf(access);
    const slot = await this.rateLimiter.acquire(actor);
    try {
      return await this.testBrandVoice.execute({ actor, brandVoiceId, brief: body.brief ?? null });
    } finally {
      await slot.release();
    }
  }

  private async load(actor: ContentActor, brandVoiceId: string): Promise<BrandVoiceDto> {
    const voice = (await this.readModel.brandVoices(refOf(actor), { includeArchived: true })).find(
      (candidate) => candidate.id === brandVoiceId,
    );
    if (!voice) {
      throw new BrandVoiceNotFoundError();
    }
    return toBrandVoiceDto(voice);
  }
}
