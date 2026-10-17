import { dataExportDownloadSchema, dataExportListSchema, dataExportSchema } from '@smp/contracts';
import { createZodDto } from 'nestjs-zod';

// Response DTOs of data protection (guide step 8.1). The schemas live in @smp/contracts, where the
// data page uses them too.

export class DataExportDto extends createZodDto(dataExportSchema) {}
export class DataExportListDto extends createZodDto(dataExportListSchema) {}
export class DataExportDownloadDto extends createZodDto(dataExportDownloadSchema) {}
