import type { OwnedOrganization, UnlimitedGrant } from '@smp/db';
import { describe, expect, it } from 'vitest';

import {
  grantUnlimited,
  OWN_USE_TICKET,
  unlimitedGrantRequestOf,
  type UnlimitedAccessStore,
} from './grant-unlimited';

// ADR 0047: the command that lets the organizations of one person run without limits and costs.

const organization = (id: string, patch: Partial<OwnedOrganization> = {}): OwnedOrganization => ({
  id,
  name: `Org ${id}`,
  unlimited: false,
  billedByStripe: false,
  ...patch,
});

const storeWith = (
  owned: { userId: string; organizations: OwnedOrganization[] } | null,
  results: Record<string, UnlimitedGrant> = {},
): UnlimitedAccessStore & { granted: string[] } => {
  const granted: string[] = [];
  return {
    granted,
    ownedOrganizations: () => Promise.resolve(owned),
    grant: (organizationId, ticket) => {
      granted.push(`${organizationId}:${ticket}`);
      return Promise.resolve(results[organizationId] ?? 'granted');
    },
  };
};

describe('unlimitedGrantRequestOf', () => {
  it('takes the address of the owner, an optional reference and whether to check only', () => {
    expect(unlimitedGrantRequestOf(['--owner', 'mira@nordlicht.test'])).toEqual({
      email: 'mira@nordlicht.test',
      ticket: OWN_USE_TICKET,
      check: false,
    });
    expect(
      unlimitedGrantRequestOf(['--check', '--owner', 'mira@nordlicht.test', '--ticket', 'OPS-7']),
    ).toEqual({
      email: 'mira@nordlicht.test',
      ticket: 'OPS-7',
      check: true,
    });
  });

  it('refuses a call without owner, with another option or with a reference of odd shape', () => {
    expect(unlimitedGrantRequestOf([])).toBeNull();
    expect(unlimitedGrantRequestOf(['--owner', 'not an address'])).toBeNull();
    expect(unlimitedGrantRequestOf(['--owner', 'mira@nordlicht.test', '--all'])).toBeNull();
    expect(unlimitedGrantRequestOf(['--owner', 'mira@nordlicht.test', '--ticket', 'two\nlines'])).toBeNull();
  });
});

describe('grantUnlimited', () => {
  const request = { email: 'mira@nordlicht.test', ticket: 'OPS-7', check: false };
  const now = new Date('2026-11-14T10:00:00Z');

  it('grants every organization the person owns and reports what happened to each', async () => {
    const store = storeWith(
      { userId: 'u1', organizations: [organization('o1'), organization('o2'), organization('o3')] },
      { o2: 'unchanged', o3: 'billed_by_stripe' },
    );

    await expect(grantUnlimited(store, request, now)).resolves.toEqual({
      status: 'done',
      userId: 'u1',
      results: [
        { organizationId: 'o1', result: 'granted' },
        { organizationId: 'o2', result: 'unchanged' },
        { organizationId: 'o3', result: 'billed_by_stripe' },
      ],
    });
    expect(store.granted).toEqual(['o1:OPS-7', 'o2:OPS-7', 'o3:OPS-7']);
  });

  it('only lists the organizations with --check and changes nothing', async () => {
    const store = storeWith({
      userId: 'u1',
      organizations: [organization('o1', { unlimited: true }), organization('o2', { billedByStripe: true })],
    });

    await expect(grantUnlimited(store, { ...request, check: true }, now)).resolves.toEqual({
      status: 'checked',
      userId: 'u1',
      organizations: [
        { organizationId: 'o1', unlimited: true, billedByStripe: false },
        { organizationId: 'o2', unlimited: false, billedByStripe: true },
      ],
    });
    expect(store.granted).toEqual([]);
  });

  it('names a missing user and a user without an organization of their own', async () => {
    await expect(grantUnlimited(storeWith(null), request, now)).resolves.toEqual({
      status: 'user_not_found',
    });
    await expect(
      grantUnlimited(storeWith({ userId: 'u1', organizations: [] }), request, now),
    ).resolves.toEqual({
      status: 'no_organization',
      userId: 'u1',
    });
  });
});
