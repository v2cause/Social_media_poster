import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { hours } from '@nestjs/throttler';
import {
  CompleteUpload,
  DeleteMedia,
  MediaNotFoundError,
  RequestUpload,
  UpdateMediaAltText,
  type ContentActor,
  type StoragePort,
} from '@smp/core';
import type { MediaReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import {
  AllowWhenReadOnly,
  RequirePermission,
  WorkspaceScope,
} from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { LimitPerUser } from '../../common/throttling/throttling';
import { MEDIA_STORAGE } from '../../infrastructure/clients.module';
import { actorOf, refOf } from '../content/content.mappers';
import {
  MediaAssetDto,
  MediaListQueryDto,
  MediaPageDto,
  RequestUploadDto,
  UpdateMediaDto,
  UploadTicketDto,
} from './media.dto';
import { toMediaAssetDto } from './media.mappers';
import { MEDIA_READ_MODEL } from './media.providers';

const id = new ParseUUIDPipe();

/**
 * The media library of a workspace (guide step 3.3, architecture 9). The browser uploads straight
 * into the storage with the presigned PUT of a ticket and then reports the upload complete; the
 * worker checks and processes the file. Responses carry signed thumbnail URLs, never the original.
 */
@ApiTags('media')
@WorkspaceScope()
@Controller('w/:ws/media')
export class MediaController {
  constructor(
    @Inject(MEDIA_READ_MODEL) private readonly readModel: MediaReadModel,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
    private readonly requestUpload: RequestUpload,
    private readonly completeUpload: CompleteUpload,
    private readonly updateAltText: UpdateMediaAltText,
    private readonly deleteMedia: DeleteMedia,
  ) {}

  @LimitPerUser(300, hours(1))
  @Post('uploads')
  @RequirePermission('media.write')
  @ZodResponse({ status: 201, type: UploadTicketDto })
  async upload(@Access() access: RequestAccess, @Body() body: RequestUploadDto): Promise<UploadTicketDto> {
    const actor = actorOf(access);
    const ticket = await this.requestUpload.execute({
      actor,
      fileName: body.fileName,
      mimeType: body.mimeType,
      size: body.size,
    });
    return {
      asset: await this.load(actor, ticket.asset.id),
      upload: { url: ticket.upload.url, method: ticket.upload.method, headers: { ...ticket.upload.headers } },
      expiresAt: ticket.expiresAt.toISOString(),
    };
  }

  @Post(':assetId/complete')
  @RequirePermission('media.write')
  @ZodResponse({ status: 200, type: MediaAssetDto })
  async complete(
    @Access() access: RequestAccess,
    @Param('assetId', id) assetId: string,
  ): Promise<MediaAssetDto> {
    const actor = actorOf(access);
    await this.completeUpload.execute({ actor, assetId });
    return this.load(actor, assetId);
  }

  @Get()
  @RequirePermission('post.read')
  @ZodResponse({ type: MediaPageDto })
  async list(@Access() access: RequestAccess, @Query() query: MediaListQueryDto): Promise<MediaPageDto> {
    const page = await this.readModel.list(
      refOf(actorOf(access)),
      { ...(query.status ? { status: query.status } : {}), ...(query.usage ? { usage: query.usage } : {}) },
      { limit: query.limit, ...(query.cursor ? { cursor: query.cursor } : {}) },
    );
    return {
      assets: await Promise.all(page.assets.map((asset) => toMediaAssetDto(asset, this.storage))),
      nextCursor: page.nextCursor,
    };
  }

  @Get(':assetId')
  @RequirePermission('post.read')
  @ZodResponse({ type: MediaAssetDto })
  get(@Access() access: RequestAccess, @Param('assetId', id) assetId: string): Promise<MediaAssetDto> {
    return this.load(actorOf(access), assetId);
  }

  @Patch(':assetId')
  @RequirePermission('media.write')
  @ZodResponse({ type: MediaAssetDto })
  async update(
    @Access() access: RequestAccess,
    @Param('assetId', id) assetId: string,
    @Body() body: UpdateMediaDto,
  ): Promise<MediaAssetDto> {
    const actor = actorOf(access);
    await this.updateAltText.execute({ actor, assetId, version: body.version, altText: body.altText });
    return this.load(actor, assetId);
  }

  @Delete(':assetId')
  @RequirePermission('media.write')
  @AllowWhenReadOnly()
  @HttpCode(204)
  async remove(@Access() access: RequestAccess, @Param('assetId', id) assetId: string): Promise<void> {
    await this.deleteMedia.execute({ actor: actorOf(access), assetId });
  }

  private async load(actor: ContentActor, assetId: string): Promise<MediaAssetDto> {
    const asset = await this.readModel.asset(refOf(actor), assetId);
    if (!asset) {
      throw new MediaNotFoundError();
    }
    return toMediaAssetDto(asset, this.storage);
  }
}
