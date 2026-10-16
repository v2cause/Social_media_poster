import { AsyncLocalStorage } from 'node:async_hooks';

import { MissingTenantContextError } from '@smp/db';
import { ClsService } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';

import { TenantContextService, type RequestContextStore } from './tenant-context';

const tenant = {
  userId: '0199f000-0000-7000-8000-000000000001',
  organizationId: '0199f000-0000-7000-8000-000000000002',
};

describe('TenantContextService', () => {
  const cls = new ClsService<RequestContextStore>(new AsyncLocalStorage());
  const service = new TenantContextService(cls);

  it('keeps the tenant per request context', async () => {
    const seen = await Promise.all(
      ['a', 'b'].map((suffix) =>
        cls.run(async () => {
          service.set({ ...tenant, workspaceId: `ws-${suffix}` });
          await new Promise((resolve) => setTimeout(resolve, 5));
          return service.require().workspaceId;
        }),
      ),
    );
    expect(seen).toEqual(['ws-a', 'ws-b']);
  });

  it('has no tenant outside a request', () => {
    expect(service.get()).toBeUndefined();
    expect(() => service.require()).toThrow(MissingTenantContextError);
  });
});
