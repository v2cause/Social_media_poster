import {
  mediaAssetSchema,
  mediaListQuerySchema,
  mediaPageSchema,
  requestUploadSchema,
  updateMediaSchema,
  uploadTicketSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Request and response DTOs of the media API (guide step 3.3). The schemas live in
// @smp/contracts, where the library and the composer use them too.

export class MediaAssetDto extends createZodDto(mediaAssetSchema) {}
export class MediaPageDto extends createZodDto(mediaPageSchema) {}
export class MediaListQueryDto extends createZodDto(mediaListQuerySchema) {}
export class RequestUploadDto extends createZodDto(requestUploadSchema) {}
export class UploadTicketDto extends createZodDto(uploadTicketSchema) {}
export class UpdateMediaDto extends createZodDto(updateMediaSchema) {}
