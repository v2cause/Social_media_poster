import {
  invitationPreviewSchema,
  meSchema,
  myMembershipsSchema,
  organizationContextSchema,
  workspaceContextSchema,
  type InvitationPreview,
  type Me,
  type MyMemberships,
  type OrganizationContext,
  type WorkspaceContext,
} from '@smp/contracts';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';

// Server-side calls to the API, for layouts that must decide before rendering: is there a session,
// which workspace is this, may the user see it. The browser's cookie is forwarded; nothing is
// cached. Responses are validated with the shared schemas, like every external input.

const API_URL = process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:3001';

interface ApiResult<T> {
  status: number;
  data: T | null;
}

async function serverFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const cookie = (await headers()).get('cookie') ?? '';
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: { accept: 'application/json', 'content-type': 'application/json', cookie },
    cache: 'no-store',
  });
  if (!response.ok) {
    return { status: response.status, data: null };
  }
  return { status: response.status, data: schema.parse(await response.json()) };
}

/** The signed-in user, or null. */
export async function getSession(): Promise<Me | null> {
  return (await serverFetch('/api/me', meSchema)).data;
}

/** The signed-in user; without session the page redirects to the sign-in. */
export async function requireSession(next: string): Promise<Me> {
  const me = await getSession();
  if (!me) {
    redirect(`/login?next=${encodeURIComponent(next)}`);
  }
  return me;
}

export async function getMemberships(): Promise<MyMemberships['memberships']> {
  return (await serverFetch('/api/me/memberships', myMembershipsSchema)).data?.memberships ?? [];
}

/** The workspace of /w/:ws; unknown or foreign workspaces render the 404 page. */
export async function getWorkspaceContext(slug: string): Promise<WorkspaceContext> {
  const result = await serverFetch(`/api/w/${encodeURIComponent(slug)}`, workspaceContextSchema);
  if (!result.data) {
    notFound();
  }
  return result.data;
}

export async function getOrganizationContext(organizationId: string): Promise<OrganizationContext> {
  const result = await serverFetch(
    `/api/org/${encodeURIComponent(organizationId)}`,
    organizationContextSchema,
  );
  if (!result.data) {
    notFound();
  }
  return result.data;
}

/** The invite page: what the token holder may see, or null for unknown tokens. */
export async function getInvitationPreview(token: string): Promise<InvitationPreview | null> {
  return (
    await serverFetch('/api/invitations/preview', invitationPreviewSchema, {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
  ).data;
}

/** Where a signed-in user starts: the first workspace, or the onboarding. */
export async function homePath(): Promise<string> {
  const first = (await getMemberships()).flatMap((membership) => membership.workspaces)[0];
  return first ? `/w/${first.slug}/dashboard` : '/onboarding';
}
