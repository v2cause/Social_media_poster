import {
  dataExportDownloadSchema,
  dataExportListSchema,
  dataExportSchema,
  organizationDeletionRequestSchema,
  organizationDeletionSchema,
} from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// DTOs of data protection (guide steps 8.1 and 8.2). The schemas live in @smp/contracts, where the
// data page uses them too.

export class DataExportDto extends createZodDto(dataExportSchema) {}
export class DataExportListDto extends createZodDto(dataExportListSchema) {}
export class DataExportDownloadDto extends createZodDto(dataExportDownloadSchema) {}
export class OrganizationDeletionRequestDto extends createZodDto(organizationDeletionRequestSchema) {}
export class OrganizationDeletionDto extends createZodDto(organizationDeletionSchema) {}
