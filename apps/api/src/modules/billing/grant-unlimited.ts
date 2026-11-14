import { parseArgs } from 'node:util';

import { emailSchema } from '@smp/contracts';
import type { OwnedOrganization, UnlimitedGrant } from '@smp/db';
import { z } from 'zod';

// `pnpm billing:grant-unlimited --owner <email> [--ticket <reference>] [--check]` (ADR 0047): the
// organizations a person owns run without limits and without costs, for the operators' own use.
// --check lists them and their state; without it, each one goes on the largest plan with every
// limit at its largest value, active, without trial or read-only. An organization that Stripe
// bills stays as it is. The log names IDs and outcomes, never the address.

export interface UnlimitedGrantRequest {
  email: string;
  /** The reference in the audit log of each organization. */
  ticket: string;
  check: boolean;
}

/** The store of the unlimited access, PrismaUnlimitedAccess in production. */
export interface UnlimitedAccessStore {
  ownedOrganizations(email: string): Promise<{ userId: string; organizations: OwnedOrganization[] } | null>;
  grant(organizationId: string, ticket: string, now: Date): Promise<UnlimitedGrant>;
}

export type UnlimitedGrantOutcome =
  | { status: 'user_not_found' }
  | { status: 'no_organization'; userId: string }
  | {
      status: 'checked';
      userId: string;
      organizations: { organizationId: string; unlimited: boolean; billedByStripe: boolean }[];
    }
  | { status: 'done'; userId: string; results: { organizationId: string; result: UnlimitedGrant }[] };

/** Without --ticket, the audit log names the own use. */
export const OWN_USE_TICKET = 'own-use';

const requestSchema = z.object({
  email: emailSchema,
  ticket: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._#-]{0,39}$/),
  check: z.boolean(),
});

/** The request of the command line; null for a call of another shape. */
export function unlimitedGrantRequestOf(args: readonly string[]): UnlimitedGrantRequest | null {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { owner: { type: 'string' }, ticket: { type: 'string' }, check: { type: 'boolean' } },
      strict: true,
    });
    const parsed = requestSchema.safeParse({
      email: values.owner,
      ticket: values.ticket ?? OWN_USE_TICKET,
      check: values.check ?? false,
    });
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function grantUnlimited(
  store: UnlimitedAccessStore,
  request: UnlimitedGrantRequest,
  now: Date,
): Promise<UnlimitedGrantOutcome> {
  const owned = await store.ownedOrganizations(request.email);
  if (!owned) {
    return { status: 'user_not_found' };
  }
  if (owned.organizations.length === 0) {
    return { status: 'no_organization', userId: owned.userId };
  }
  if (request.check) {
    return {
      status: 'checked',
      userId: owned.userId,
      organizations: owned.organizations.map((organization) => ({
        organizationId: organization.id,
        unlimited: organization.unlimited,
        billedByStripe: organization.billedByStripe,
      })),
    };
  }
  const results: { organizationId: string; result: UnlimitedGrant }[] = [];
  for (const organization of owned.organizations) {
    results.push({
      organizationId: organization.id,
      result: await store.grant(organization.id, request.ticket, now),
    });
  }
  return { status: 'done', userId: owned.userId, results };
}
