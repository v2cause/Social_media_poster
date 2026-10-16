import { Controller, Get } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { OrgScope, RequirePermission, UserScope } from '../src/common/decorators/access.decorators';
import { Public } from '../src/common/decorators/public.decorator';
import { RouteAccessCheck } from '../src/common/guards/route-access.check';

// Deny by default (guide step 1.6): the application does not start with a route that has no
// access rule, two of them, or a permission without tenant scope.

@Controller('fine')
class FineController {
  @Public()
  @Get('public')
  open(): string {
    return 'ok';
  }

  @UserScope()
  @Get('user')
  user(): string {
    return 'ok';
  }
}

@Controller('forgotten')
class ForgottenController {
  @Get()
  leak(): string {
    return 'secret';
  }
}

@Controller('unscoped')
class UnscopedController {
  @RequirePermission('member.manage')
  @Get()
  manage(): string {
    return 'ok';
  }
}

@OrgScope()
@Controller('org/:org/double')
class DoubleController {
  @Public()
  @RequirePermission('org.read')
  @Get()
  both(): string {
    return 'ok';
  }
}

async function boot(...controllers: (new () => object)[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [DiscoveryModule],
    controllers,
    providers: [RouteAccessCheck],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  try {
    await app.init();
    return app.get(RouteAccessCheck).routes;
  } finally {
    await app.close();
  }
}

describe('route access check', () => {
  it('lists the routes with their access rule', async () => {
    await expect(boot(FineController)).resolves.toEqual([
      expect.objectContaining({ method: 'GET', path: '/api/fine/public', access: 'public' }),
      expect.objectContaining({ method: 'GET', path: '/api/fine/user', access: 'user' }),
    ]);
  });

  it('stops the application for a route without access rule', async () => {
    await expect(boot(FineController, ForgottenController)).rejects.toThrow(/GET \/api\/forgotten/);
  });

  it('stops the application for a permission without tenant scope or with a second rule', async () => {
    await expect(boot(UnscopedController)).rejects.toThrow(/needs @OrgScope\(\) or @WorkspaceScope\(\)/);
    await expect(boot(DoubleController)).rejects.toThrow(/more than one/);
  });
});
