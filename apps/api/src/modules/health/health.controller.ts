import { Controller, Get } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { minutes, SkipThrottle } from '@nestjs/throttler';

import { Public } from '../../common/decorators/public.decorator';
import { LimitPerUser } from '../../common/throttling/throttling';
import { DatabaseHealthIndicator } from './indicators/database.indicator';
import { RedisHealthIndicator } from './indicators/redis.indicator';
import { S3HealthIndicator } from './indicators/s3.indicator';

// Health endpoints need no authentication and are excluded from request logging. They count only
// against the limit per client address; the readiness check, which asks every dependency, has a
// limit of its own (guide step 8.4).
@Public()
@SkipThrottle({ user: true })
@ApiExcludeController()
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
  @LimitPerUser(60, minutes(1))
  ready() {
    return this.health.check([
      () => this.database.isHealthy(),
      () => this.redis.isHealthy(),
      () => this.s3.isHealthy(),
    ]);
  }
}
