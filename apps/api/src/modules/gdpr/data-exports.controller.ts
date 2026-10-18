import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { days, hours } from '@nestjs/throttler';
import {
  DownloadDataExport,
  ListDataExports,
  RequestDataExport,
  systemClock,
  type OrganizationActor,
} from '@smp/core';
import { ZodResponse } from 'nestjs-zod';

import {
  AllowWhenDeleted,
  AllowWhenReadOnly,
  OrgScope,
  RequirePermission,
} from '../../common/decorators/access.decorators';
import { Actor } from '../../common/guards/request-access';
import { LimitPerUser } from '../../common/throttling/throttling';
import { DataExportDownloadDto, DataExportDto, DataExportListDto } from './gdpr.dto';
import { toDataExportDto } from './gdpr.mappers';

/**
 * The data exports of an organization for its owners (guide step 8.1): ask for one, see the
 * latest ones and download a finished one. The response never holds the archive or its key; a
 * download asks for a link of five minutes, and the audit log keeps every download.
 */
@ApiTags('data-exports')
@OrgScope()
// The right to the data does not depend on a paid plan, and it lasts until the erasure.
@AllowWhenReadOnly()
@AllowWhenDeleted()
@Controller('org/:org/data-exports')
export class DataExportsController {
  constructor(
    private readonly requestExport: RequestDataExport,
    private readonly listExports: ListDataExports,
    private readonly downloadExport: DownloadDataExport,
  ) {}

  @Get()
  @RequirePermission('org.export')
  @ZodResponse({ type: DataExportListDto })
  async list(@Actor() actor: OrganizationActor): Promise<DataExportListDto> {
    const now = systemClock.now();
    return { items: (await this.listExports.execute(actor)).map((request) => toDataExportDto(request, now)) };
  }

  /** A new export, or the one that waits or runs already. */
  @LimitPerUser(5, days(1))
  @Post()
  @RequirePermission('org.export')
  @HttpCode(202)
  @ZodResponse({ status: 202, type: DataExportDto })
  async create(@Actor() actor: OrganizationActor): Promise<DataExportDto> {
    return toDataExportDto(await this.requestExport.execute(actor), systemClock.now());
  }

  @LimitPerUser(30, hours(1))
  @Post(':exportId/download')
  @RequirePermission('org.export')
  @HttpCode(201)
  @ZodResponse({ status: 201, type: DataExportDownloadDto })
  async download(
    @Actor() actor: OrganizationActor,
    @Param('exportId', new ParseUUIDPipe()) exportId: string,
  ): Promise<DataExportDownloadDto> {
    const link = await this.downloadExport.execute(actor, exportId);
    return { url: link.url, expiresAt: link.expiresAt.toISOString() };
  }
}
