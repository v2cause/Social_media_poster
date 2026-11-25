import { UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';

import type { TenantContextService } from '../../common/cls/tenant-context';
import type { Auth, AuthSession } from './auth';
import { AuthGuard, type AuthenticatedRequest } from './auth.guard';
import { LocalSession } from './local-session';

const sessionOf = (userId: string) =>
  ({ user: { id: userId }, session: { id: `s-${userId}` } }) as unknown as AuthSession;

function setup(found: AuthSession | null, local: AuthSession | null) {
  const auth = { api: { getSession: vi.fn().mockResolvedValue(found) } } as unknown as Auth;
  const reflector = { getAllAndOverride: () => undefined } as unknown as Reflector;
  const setTenant = vi.fn();
  const tenant = { set: setTenant } as unknown as TenantContextService;
  const localSession = new LocalSession();
  if (local) {
    localSession.set(local);
  }
  const request = { headers: {} } as AuthenticatedRequest;
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { guard: new AuthGuard(auth, reflector, tenant, localSession), request, context, setTenant };
}

describe('AuthGuard', () => {
  it('rejects a request without a session outside the single-user mode', async () => {
    const { guard, context } = setup(null, null);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('lets the local owner stand in for a missing session in the single-user mode', async () => {
    const { guard, context, request, setTenant } = setup(null, sessionOf('local-owner'));

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.auth?.user.id).toBe('local-owner');
    expect(setTenant).toHaveBeenCalledWith({ userId: 'local-owner' });
  });

  it('prefers a real session over the local owner', async () => {
    const { guard, context, request } = setup(sessionOf('signed-in'), sessionOf('local-owner'));

    await guard.canActivate(context);

    expect(request.auth?.user.id).toBe('signed-in');
  });
});
