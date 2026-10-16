// Workspace slugs: lowercase letters, digits and single hyphens, globally unique (ADR 0010).

const MAX_LENGTH = 40;
const FALLBACK = 'workspace';

/** Derives a slug from a workspace name, for example "Marketing & Sales" -> "marketing-sales". */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_LENGTH)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : FALLBACK;
}

/** The slug with a suffix, for a second attempt after a collision. */
export const withSuffix = (slug: string, suffix: string): string =>
  `${slug.slice(0, MAX_LENGTH - suffix.length - 1)}-${suffix}`;

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
