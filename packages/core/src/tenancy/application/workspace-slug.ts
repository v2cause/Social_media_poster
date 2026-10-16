import { SlugUnavailableError } from '../domain/errors';
import { slugify, withSuffix } from '../domain/slug';
import type { Workspace } from '../domain/types';
import type { SecretTokens } from '../ports/secret-tokens';
import type { TenancyStore } from '../ports/tenancy-store';

const MAX_ATTEMPTS = 5;

/**
 * Creates the workspace under the slug of its name, or with a random suffix if that slug is
 * taken in any organization (ADR 0010). Returns the slug.
 */
export async function createWorkspaceWithFreeSlug(
  store: TenancyStore,
  tokens: SecretTokens,
  workspace: Omit<Workspace, 'slug'>,
): Promise<string> {
  const base = slugify(workspace.name);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const slug = attempt === 0 ? base : withSuffix(base, tokens.slugSuffix());
    if (await store.workspaces.create({ ...workspace, slug })) {
      return slug;
    }
  }
  throw new SlugUnavailableError();
}
