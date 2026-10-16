import { Global, Module } from '@nestjs/common';
import type { Request } from 'express';
import { ClsModule } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';

import { TenantContextService } from './tenant-context';

/**
 * Opens one context per request. Its id is the request id that the request-id middleware set
 * before, so log lines and the context belong together.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRoot({
      middleware: {
        mount: true,
        generateId: true,
        idGenerator: (req: Request) => (typeof req.id === 'string' ? req.id : uuidv7()),
      },
    }),
  ],
  providers: [TenantContextService],
  exports: [TenantContextService],
})
export class RequestContextModule {}
