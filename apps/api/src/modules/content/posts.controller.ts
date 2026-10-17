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
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import {
  CreatePost,
  DeletePost,
  PostNotFoundError,
  SetVariantMedia,
  UpdatePost,
  UpdateVariant,
  VariantNotFoundError,
  type ContentActor,
  type StoragePort,
} from '@smp/core';
import type { ContentReadModel } from '@smp/db';
import { ZodResponse } from 'nestjs-zod';

import {
  AllowWhenReadOnly,
  RequirePermission,
  WorkspaceScope,
} from '../../common/decorators/access.decorators';
import { Access, type RequestAccess } from '../../common/guards/request-access';
import { MEDIA_STORAGE } from '../../infrastructure/clients.module';
import {
  CreatePostDto,
  PostDto,
  PostListQueryDto,
  PostPageDto,
  SetVariantMediaDto,
  UpdatePostDto,
  UpdateVariantDto,
  VariantDto,
} from './content.dto';
import { actorOf, refOf, toPostDto, toVariantDto } from './content.mappers';
import { CONTENT_READ_MODEL } from './content.providers';

const id = new ParseUUIDPipe();

/** Posts of a workspace with their variants (guide step 2.7). */
@ApiTags('posts')
@WorkspaceScope()
@Controller('w/:ws/posts')
export class PostsController {
  constructor(
    @Inject(CONTENT_READ_MODEL) private readonly readModel: ContentReadModel,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
    private readonly createPost: CreatePost,
    private readonly updatePost: UpdatePost,
    private readonly deletePost: DeletePost,
  ) {}

  @Get()
  @RequirePermission('post.read')
  @ZodResponse({ type: PostPageDto })
  async list(@Access() access: RequestAccess, @Query() query: PostListQueryDto): Promise<PostPageDto> {
    const page = await this.readModel.listPosts(refOf(actorOf(access)), {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return {
      posts: page.posts.map((post) => ({ ...post, updatedAt: post.updatedAt.toISOString() })),
      nextCursor: page.nextCursor,
    };
  }

  @Post()
  @RequirePermission('post.write')
  @ZodResponse({ status: 201, type: PostDto })
  async create(@Access() access: RequestAccess, @Body() body: CreatePostDto): Promise<PostDto> {
    const actor = actorOf(access);
    const { postId } = await this.createPost.execute({
      actor,
      brief: body.brief,
      language: body.language,
      styleId: body.styleId,
      brandVoiceId: body.brandVoiceId,
      ideaId: body.ideaId,
      platforms: body.platforms,
    });
    return this.load(actor, postId);
  }

  @Get(':postId')
  @RequirePermission('post.read')
  @ZodResponse({ type: PostDto })
  get(@Access() access: RequestAccess, @Param('postId', id) postId: string): Promise<PostDto> {
    return this.load(actorOf(access), postId);
  }

  @Patch(':postId')
  @RequirePermission('post.write')
  @ZodResponse({ type: PostDto })
  async update(
    @Access() access: RequestAccess,
    @Param('postId', id) postId: string,
    @Body() body: UpdatePostDto,
  ): Promise<PostDto> {
    const actor = actorOf(access);
    const { version, platforms, ...patch } = body;
    await this.updatePost.execute({ actor, postId, version, patch, ...(platforms ? { platforms } : {}) });
    return this.load(actor, postId);
  }

  @Delete(':postId')
  @RequirePermission('post.delete')
  @AllowWhenReadOnly()
  @HttpCode(204)
  async remove(@Access() access: RequestAccess, @Param('postId', id) postId: string): Promise<void> {
    await this.deletePost.execute({ actor: actorOf(access), postId });
  }

  private async load(actor: ContentActor, postId: string): Promise<PostDto> {
    const post = await this.readModel.post(refOf(actor), postId);
    if (!post) {
      throw new PostNotFoundError();
    }
    return toPostDto(post, this.storage);
  }
}

/** The editor saves one variant at a time, text and media, with optimistic locking. */
@ApiTags('posts')
@WorkspaceScope()
@Controller('w/:ws/variants')
export class VariantsController {
  constructor(
    @Inject(CONTENT_READ_MODEL) private readonly readModel: ContentReadModel,
    @Inject(MEDIA_STORAGE) private readonly storage: StoragePort,
    private readonly updateVariant: UpdateVariant,
    private readonly setVariantMedia: SetVariantMedia,
  ) {}

  @Patch(':variantId')
  @RequirePermission('post.write')
  @ZodResponse({ type: VariantDto })
  async update(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: UpdateVariantDto,
  ): Promise<VariantDto> {
    const actor = actorOf(access);
    const { version, ...patch } = body;
    await this.updateVariant.execute({ actor, variantId, version, patch });
    return this.load(actor, variantId);
  }

  /**
   * Replaces the media of the variant (guide step 3.4). Queues the renditions for its platform;
   * crop and letterbox are kept per use.
   */
  @Put(':variantId/media')
  @RequirePermission('post.write')
  @ZodResponse({ type: VariantDto })
  async setMedia(
    @Access() access: RequestAccess,
    @Param('variantId', id) variantId: string,
    @Body() body: SetVariantMediaDto,
  ): Promise<VariantDto> {
    const actor = actorOf(access);
    await this.setVariantMedia.execute({ actor, variantId, version: body.version, items: body.items });
    return this.load(actor, variantId);
  }

  private async load(actor: ContentActor, variantId: string): Promise<VariantDto> {
    const variant = await this.readModel.variant(refOf(actor), variantId);
    if (!variant) {
      throw new VariantNotFoundError();
    }
    return toVariantDto(variant, this.storage);
  }
}
