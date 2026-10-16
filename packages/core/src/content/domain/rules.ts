import { isManager } from '../../tenancy/domain/roles';
import type { MemberRole } from '../../tenancy/domain/types';
import type { VariantStatus } from './types';

// Rules of the content context (architecture 10 and 6.2).

/** Editors and above write posts, use the AI and handle ideas; viewers only read. */
export const canWriteContent = (role: MemberRole): boolean => role !== 'VIEWER';

/** Brand voices and custom styles shape every post of a workspace: owners and admins only. */
export const canManageBrand = (role: MemberRole): boolean => isManager(role);

// Architecture 7.2: a variant waiting for attention stays as it is, because the reconcile looks
// for the content that may have gone out.
const EDITABLE: readonly VariantStatus[] = ['DRAFT', 'SCHEDULED', 'FAILED', 'CANCELED'];
const IN_FLIGHT: readonly VariantStatus[] = ['QUEUED', 'PUBLISHING', 'RETRYING'];

/** Whether the content of a variant may change. */
export const isVariantEditable = (status: VariantStatus): boolean => EDITABLE.includes(status);

/** The status after an edit: a failed or canceled variant becomes a draft again. */
export const statusAfterEdit = (status: VariantStatus): VariantStatus =>
  status === 'FAILED' || status === 'CANCELED' ? 'DRAFT' : status;

/** Whether a publish of the variant is under way; its post must not change then. */
export const isVariantInFlight = (status: VariantStatus): boolean => IN_FLIGHT.includes(status);

/** The keys of new targets: the lowest numbers t1, t2, ... that are still free. */
export function nextTargetKeys(taken: readonly string[], count: number): string[] {
  const used = new Set(taken);
  const keys: string[] = [];
  for (let number = 1; keys.length < count; number += 1) {
    const key = `t${String(number)}`;
    if (!used.has(key)) {
      keys.push(key);
    }
  }
  return keys;
}

const STYLE_SLUG_MAX = 40;

/** The key of a custom style: "custom-" and a slug of its name, for example "custom-short-and-warm". */
export function customStyleKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u00df/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, STYLE_SLUG_MAX)
    .replace(/-+$/g, '');
  return `custom-${slug.length > 0 ? slug : 'style'}`;
}

/** JSON with sorted object keys, so equal content gives equal text (and equal hashes). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}
