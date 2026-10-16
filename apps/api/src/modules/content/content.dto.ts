import {
  brandVoiceListSchema,
  brandVoiceSchema,
  brandVoiceTestResponseSchema,
  brandVoiceVersionListSchema,
  createBrandVoiceSchema,
  createPostSchema,
  createStyleSchema,
  generateIdeasResponseSchema,
  generateIdeasSchema,
  generateVariantsSchema,
  ideaListQuerySchema,
  ideaListSchema,
  ideaSchema,
  postListQuerySchema,
  postPageSchema,
  postSchema,
  refineVariantSchema,
  setVariantMediaSchema,
  styleListSchema,
  styleSchema,
  testBrandVoiceSchema,
  updateBrandVoiceSchema,
  updateIdeaSchema,
  updatePostSchema,
  updateStyleSchema,
  updateVariantSchema,
  variantSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Request and response DTOs of the content and AI API (guide step 2.7). The schemas live in
// @smp/contracts, where the composer and the settings pages use them too.

export class PostDto extends createZodDto(postSchema) {}
export class PostPageDto extends createZodDto(postPageSchema) {}
export class PostListQueryDto extends createZodDto(postListQuerySchema) {}
export class CreatePostDto extends createZodDto(createPostSchema) {}
export class UpdatePostDto extends createZodDto(updatePostSchema) {}
export class VariantDto extends createZodDto(variantSchema) {}
export class UpdateVariantDto extends createZodDto(updateVariantSchema) {}
export class SetVariantMediaDto extends createZodDto(setVariantMediaSchema) {}

export class StyleDto extends createZodDto(styleSchema) {}
export class StyleListDto extends createZodDto(styleListSchema) {}
export class CreateStyleDto extends createZodDto(createStyleSchema) {}
export class UpdateStyleDto extends createZodDto(updateStyleSchema) {}

export class BrandVoiceDto extends createZodDto(brandVoiceSchema) {}
export class BrandVoiceListDto extends createZodDto(brandVoiceListSchema) {}
export class BrandVoiceListQueryDto extends createZodDto(
  z.object({ archived: z.stringbool().default(false) }),
) {}
export class CreateBrandVoiceDto extends createZodDto(createBrandVoiceSchema) {}
export class UpdateBrandVoiceDto extends createZodDto(updateBrandVoiceSchema) {}
export class BrandVoiceVersionListDto extends createZodDto(brandVoiceVersionListSchema) {}
export class TestBrandVoiceDto extends createZodDto(testBrandVoiceSchema) {}
export class BrandVoiceTestResponseDto extends createZodDto(brandVoiceTestResponseSchema) {}

export class IdeaDto extends createZodDto(ideaSchema) {}
export class IdeaListDto extends createZodDto(ideaListSchema) {}
export class IdeaListQueryDto extends createZodDto(ideaListQuerySchema) {}
export class GenerateIdeasDto extends createZodDto(generateIdeasSchema) {}
export class GenerateIdeasResponseDto extends createZodDto(generateIdeasResponseSchema) {}
export class UpdateIdeaDto extends createZodDto(updateIdeaSchema) {}

export class GenerateVariantsDto extends createZodDto(generateVariantsSchema) {}
export class RefineVariantDto extends createZodDto(refineVariantSchema) {}
