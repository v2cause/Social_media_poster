import { Global, Module } from '@nestjs/common';
import type { Request } from 'express';
import { ClsModule, type ClsService } from 'nestjs-cls';
import { uuidv7 } from 'uuidv7';

import { RequestOriginService, TenantContextService, type RequestContextStore } from './tenant-context';

// User agents are capped: the header is client-controlled and ends up in the audit log.
const MAX_USER_AGENT = 300;

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
        setup: (cls: ClsService<RequestContextStore>, req: Request) => {
          cls.set('origin', {
            ipAddress: req.ip,
            userAgent: req.get('user-agent')?.slice(0, MAX_USER_AGENT),
          });
        },
      },
    }),
  ],
  providers: [TenantContextService, RequestOriginService],
  exports: [TenantContextService, RequestOriginService],
})
export class RequestContextModule {}
