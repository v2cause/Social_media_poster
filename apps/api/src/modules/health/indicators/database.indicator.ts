import { Inject, Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';
import type { PrismaClient } from '@smp/db';

import { DATABASE_CLIENT } from '../../../infrastructure/clients.module';

@Injectable()
export class DatabaseHealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(DATABASE_CLIENT) private readonly prisma: PrismaClient,
  ) {}

  async isHealthy(key = 'database'): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicator.up();
    } catch {
      // Driver messages can contain connection details, so only a fixed message is reported.
      return indicator.down('unreachable');
    }
  }
}
