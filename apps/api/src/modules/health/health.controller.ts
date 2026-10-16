import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { Public } from '../../common/decorators/public.decorator';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { S3HealthIndicator } from './indicators/s3.indicator';

// Health endpoints need no authentication and are excluded from request logging.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: DatabaseHealthIndicator,
    private readonly redis: RedisHealthIndicator,
    private readonly s3: S3HealthIndicator,
  ) {}

  /** The process is up and serving requests. It does not check dependencies. */
  @Get('live')
  @HealthCheck()
  live() {
    return this.health.check([]);
  }

  /** The API can serve traffic: database, Redis and object storage respond. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.database.isHealthy(),
      () => this.redis.isHealthy(),
      () => this.s3.isHealthy(),
    ]);
  }
}
