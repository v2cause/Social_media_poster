import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { AuditController } from './audit.controller';

@Module({ imports: [AccessModule], controllers: [AuditController] })
export class AuditModule {}
