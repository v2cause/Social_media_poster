import type { CreateOrganization } from '@smp/core';
import type { SystemPrismaClient } from '@smp/db';
import { describe, expect, it, vi } from 'vitest';

import type { Auth } from '../identity/auth';
import { LocalSession } from '../identity/local-session';
import { LocalOwnerBootstrap } from './local-owner.bootstrap';

const OWNER = { id: 'user-1', email: 'owner@local.invalid', name: 'Lokal' };

function setup(options: { localMode: boolean; existingUser: boolean; memberships: number }) {
  const findUserByEmail = vi.fn().mockResolvedValue(options.existingUser ? { user: OWNER } : null);
  const createUser = vi.fn().mockResolvedValue(OWNER);
  const auth = { $context: Promise.resolve({ internalAdapter: { findUserByEmail, createUser } }) };
  const findMany = vi.fn().mockResolvedValue(
    Array.from({ length: options.memberships }, (_, index) => ({
      organizationId: `org-${String(index)}`,
      role: 'OWNER',
      organization: { requireTwoFactor: false, _count: { memberships: 0 } },
    })),
  );
  const system = { membership: { findMany } };
  const execute = vi.fn().mockResolvedValue({});
  const localSession = new LocalSession();
  const bootstrap = new LocalOwnerBootstrap(
    { LOCAL_MODE: options.localMode, LOCAL_USER_EMAIL: 'Owner@Local.invalid', LOCAL_USER_NAME: 'Lokal' },
    auth as unknown as Auth,
    system as unknown as SystemPrismaClient,
    localSession,
    { execute } as unknown as CreateOrganization,
  );
  return { bootstrap, localSession, createUser, findUserByEmail, execute };
}

describe('LocalOwnerBootstrap', () => {
  it('does nothing outside the single-user mode', async () => {
    const { bootstrap, localSession, findUserByEmail } = setup({
      localMode: false,
      existingUser: false,
      memberships: 0,
    });

    await bootstrap.onApplicationBootstrap();

    expect(findUserByEmail).not.toHaveBeenCalled();
    expect(localSession.get()).toBeNull();
  });

  it('creates the owner with an organization and a workspace on the first start', async () => {
    const { bootstrap, localSession, createUser, execute } = setup({
      localMode: true,
      existingUser: false,
      memberships: 0,
    });

    await bootstrap.onApplicationBootstrap();

    expect(createUser).toHaveBeenCalledWith(
      { email: 'owner@local.invalid', name: 'Lokal', emailVerified: true },
      { method: 'admin' },
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 'user-1', emailVerified: true },
        name: 'Lokal',
        workspace: expect.objectContaining({ name: 'Lokal', contentLanguage: 'de' }) as unknown,
      }),
    );
    expect(localSession.get()?.user.id).toBe('user-1');
  });

  it('reuses the owner and the organization on later starts', async () => {
    const { bootstrap, localSession, createUser, execute } = setup({
      localMode: true,
      existingUser: true,
      memberships: 1,
    });

    await bootstrap.onApplicationBootstrap();

    expect(createUser).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(localSession.get()?.session.expiresAt.getUTCFullYear()).toBe(9999);
  });
});
