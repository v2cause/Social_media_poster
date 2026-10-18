import { Module } from '@nestjs/common';

import { AccessModule } from '../../common/guards/access.module';
import { BillingModule } from '../billing/billing.module';
import { DataExportsController } from './data-exports.controller';
import { gdprProviders } from './gdpr.providers';
import { OrganizationDeletionController } from './organization-deletion.controller';

/** Data protection of an organization: its exports and its deletion (guide steps 8.1 and 8.2). */
@Module({
  imports: [AccessModule, BillingModule],
  controllers: [DataExportsController, OrganizationDeletionController],
  providers: gdprProviders,
})
export class GdprModule {}
