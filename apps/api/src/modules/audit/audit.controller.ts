import { Controller, Get, Inject, Query } from '@nestjs/common';
import { auditLogPageSchema, auditLogQuerySchema } from '@smp/contracts';
import type { OrganizationActor } from '@smp/core';
import type { AuditLogReadModel } from '@smp/db';
import { createZodDto, ZodSerializerDto } from 'nestjs-zod';

import { OrgScope, RequirePermission } from '../../common/decorators/access.decorators';
import { Actor } from '../../common/guards/request-access';
import { AUDIT_LOG_READ_MODEL } from '../../infrastructure/clients.module';

class AuditLogQueryDto extends createZodDto(auditLogQuerySchema) {}
class AuditLogPageDto extends createZodDto(auditLogPageSchema) {}

/** The audit log of an organization for owners and admins (guide step 1.7). */
@OrgScope()
@Controller('org/:org/audit-log')
export class AuditController {
  constructor(@Inject(AUDIT_LOG_READ_MODEL) private readonly auditLog: AuditLogReadModel) {}

  @Get()
  @RequirePermission('audit.read')
  @ZodSerializerDto(AuditLogPageDto)
  async list(@Actor() actor: OrganizationActor, @Query() query: AuditLogQueryDto): Promise<AuditLogPageDto> {
    const page = await this.auditLog.list(actor, {
      action: query.action,
      actorUserId: query.actorUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      entries: page.entries.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
      nextCursor: page.nextCursor,
    };
  }
}
