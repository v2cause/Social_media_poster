import {
  brandVoiceListSchema,
  ideaListSchema,
  invitationPreviewSchema,
  meSchema,
  myMembershipsSchema,
  organizationContextSchema,
  postSchema,
  styleListSchema,
  workspaceContextSchema,
  type BrandVoiceDto,
  type IdeaDto,
  type InvitationPreview,
  type Me,
  type MyMemberships,
  type OrganizationContext,
  type PostDto,
  type StyleDto,
  type WorkspaceContext,
} from '@smp/contracts';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import type { z } from 'zod';

// Server-side calls to the API, for layouts that must decide before rendering: is there a session,
// which workspace is this, may the user see it. The browser's cookie is forwarded, and the client
// address that the reverse proxy set, so that the rate limits of the API count the user and not
// the web app (guide step 8.4), and the request ID of the proxy, which the API logs as
// clientRequestId (guide step 8.7). Nothing is cached. Responses are validated with the shared
// schemas, like every external input.

const API_URL = process.env['API_INTERNAL_URL'] ?? 'http://127.0.0.1:3001';

interface ApiResult<T> {
  status: number;
  data: T | null;
  /** The code of a problem the API answered with. */
  code?: string;
}

/** Where a member goes whose organization requires a second factor (guide step 8.4). */
const TWO_FACTOR_SETUP = '/account/security?required=two-factor';

async function serverFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  const incoming = await headers();
  const cookie = incoming.get('cookie') ?? '';
  const clientAddress = incoming.get('x-real-ip');
  const requestId = incoming.get('x-request-id');
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      cookie,
      ...(clientAddress ? { 'x-real-ip': clientAddress } : {}),
      ...(requestId ? { 'x-request-id': requestId } : {}),
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    const problem = (await response.json().catch(() => null)) as { code?: unknown } | null;
    return {
      status: response.status,
      data: null,
      ...(typeof problem?.code === 'string' ? { code: problem.code } : {}),
    };
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

/**
 * The workspace of /w/:ws; unknown or foreign workspaces render the 404 page, and a member without
 * the second factor the organization requires goes to the security page to set it up.
 */
export async function getWorkspaceContext(slug: string): Promise<WorkspaceContext> {
  const result = await serverFetch(`/api/w/${encodeURIComponent(slug)}`, workspaceContextSchema);
  if (result.code === 'TWO_FACTOR_REQUIRED') {
    redirect(TWO_FACTOR_SETUP);
  }
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
  if (result.code === 'TWO_FACTOR_REQUIRED') {
    redirect(TWO_FACTOR_SETUP);
  }
  if (!result.data) {
    notFound();
  }
  return result.data;
}

/** The post of /w/:ws/posts/:postId; unknown posts render the 404 page. */
export async function getPost(slug: string, postId: string): Promise<PostDto> {
  const result = await serverFetch(
    `/api/w/${encodeURIComponent(slug)}/posts/${encodeURIComponent(postId)}`,
    postSchema,
  );
  if (!result.data) {
    notFound();
  }
  return result.data;
}

/** What the composer offers: the styles and the brand voices that are not archived. */
export async function getComposerOptions(
  slug: string,
): Promise<{ styles: StyleDto[]; voices: BrandVoiceDto[] }> {
  const base = `/api/w/${encodeURIComponent(slug)}`;
  const [styles, voices] = await Promise.all([
    serverFetch(`${base}/styles`, styleListSchema),
    serverFetch(`${base}/brand-voices`, brandVoiceListSchema),
  ]);
  return { styles: styles.data?.styles ?? [], voices: voices.data?.brandVoices ?? [] };
}

/** A brand voice of the workspace, archived ones included; unknown voices render the 404 page. */
export async function getBrandVoice(slug: string, voiceId: string): Promise<BrandVoiceDto> {
  const result = await serverFetch(
    `/api/w/${encodeURIComponent(slug)}/brand-voices?archived=true`,
    brandVoiceListSchema,
  );
  const voice = result.data?.brandVoices.find((candidate) => candidate.id === voiceId);
  if (!voice) {
    notFound();
  }
  return voice;
}

/** An idea of the workspace for a new post, or null when it does not exist. */
export async function getIdea(slug: string, ideaId: string): Promise<IdeaDto | null> {
  const result = await serverFetch(`/api/w/${encodeURIComponent(slug)}/ideas`, ideaListSchema);
  return result.data?.ideas.find((idea) => idea.id === ideaId) ?? null;
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
