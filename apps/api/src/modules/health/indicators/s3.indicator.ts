import { HeadBucketCommand, type S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable } from '@nestjs/common';
import { type HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

import type { ApiEnv } from '../../../config/api-env';
import { API_ENV } from '../../../config/config.module';
import { S3_CLIENT } from '../../../infrastructure/clients.module';

@Injectable()
export class S3HealthIndicator {
  constructor(
    private readonly indicators: HealthIndicatorService,
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async isHealthy(key = 's3'): Promise<HealthIndicatorResult> {
    const indicator = this.indicators.check(key);
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.env.S3_BUCKET }));
      return indicator.up();
    } catch {
      return indicator.down('unreachable');
    }
  }
}
