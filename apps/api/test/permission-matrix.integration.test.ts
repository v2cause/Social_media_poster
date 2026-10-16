import { randomUUID } from 'node:crypto';

import { can, ROLES, type Permission, type Role } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RouteAccessCheck } from '../src/common/guards/route-access.check';
import { startApiTestApp, type ApiTestApp } from './support/api-app';
import { signIn, type Browser } from './support/browser';

// Guide step 1.6, "Fertig, wenn": a matrix test generated from ROLE_PERMISSIONS, role x endpoint.
// Every role calls every tenant route. Roles with the permission must get past the guards (any
// status but 403), all others get 403 NOT_PERMITTED. Targets are unknown ids where possible, so
// that the calls change nothing; the one destructive call (leave) runs last.

const SEED_PASSWORD = 'seed-password-for-the-matrix-test';

interface Endpoint {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** The route as RouteAccessCheck lists it. */
  route: string;
  permission: Permission;
  path: (ids: { organizationId: string; slug: string }) => string;
  body?: (role: Role) => object;
}

const unknownId = randomUUID();

const ENDPOINTS: Endpoint[] = [
  {
    method: 'get',
    route: '/api/org/:org',
    permission: 'org.read',
    path: (i) => `/api/org/${i.organizationId}`,
  },
  {
    method: 'get',
    route: '/api/org/:org/members',
    permission: 'member.read',
    path: (i) => `/api/org/${i.organizationId}/members`,
  },
  {
    method: 'patch',
    route: '/api/org/:org/members/:membershipId',
    permission: 'member.manage',
    path: (i) => `/api/org/${i.organizationId}/members/${unknownId}`,
    body: () => ({ role: 'VIEWER' }),
  },
  {
    method: 'delete',
    route: '/api/org/:org/members/:membershipId',
    permission: 'member.manage',
    path: (i) => `/api/org/${i.organizationId}/members/${unknownId}`,
  },
  {
    method: 'get',
    route: '/api/org/:org/invitations',
    permission: 'member.manage',
    path: (i) => `/api/org/${i.organizationId}/invitations`,
  },
  {
    method: 'post',
    route: '/api/org/:org/invitations',
    permission: 'member.manage',
    path: (i) => `/api/org/${i.organizationId}/invitations`,
    body: (role) => ({ email: `invited-by-${role.toLowerCase()}@example.test`, role: 'VIEWER' }),
  },
  {
    method: 'post',
    route: '/api/org/:org/invitations/:invitationId/resend',
    permission: 'member.manage',
    path: (i) => `/api/org/${i.organizationId}/invitations/${unknownId}/resend`,
  },
  {
    method: 'delete',
    route: '/api/org/:org/invitations/:invitationId',
    permission: 'member.manage',
    path: (i) => `/api/org/${i.organizationId}/invitations/${unknownId}`,
  },
  {
    method: 'get',
    route: '/api/org/:org/workspaces',
    permission: 'workspace.manage',
    path: (i) => `/api/org/${i.organizationId}/workspaces`,
  },
  {
    method: 'post',
    route: '/api/org/:org/workspaces',
    permission: 'workspace.manage',
    path: (i) => `/api/org/${i.organizationId}/workspaces`,
    body: (role) => ({
      name: `Created by ${role}`,
      timezone: 'UTC',
      contentLanguage: 'en',
    }),
  },
  { method: 'get', route: '/api/w/:ws', permission: 'workspace.read', path: (i) => `/api/w/${i.slug}` },
  {
    method: 'get',
    route: '/api/w/:ws/settings',
    permission: 'workspace.read',
    path: (i) => `/api/w/${i.slug}/settings`,
  },
  {
    method: 'patch',
    route: '/api/w/:ws/settings',
    permission: 'settings.manage',
    path: (i) => `/api/w/${i.slug}/settings`,
    body: () => ({ dryRun: true }),
  },
  {
    method: 'get',
    route: '/api/org/:org/audit-log',
    permission: 'audit.read',
    path: (i) => `/api/org/${i.organizationId}/audit-log`,
  },
  // Content and AI (guide step 2.7): unknown ids where possible; the creating calls create.
  {
    method: 'get',
    route: '/api/w/:ws/posts',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/posts`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/posts',
    permission: 'post.write',
    path: (i) => `/api/w/${i.slug}/posts`,
    body: (role) => ({ brief: `Post of ${role}`, language: 'de', platforms: ['LINKEDIN'] }),
  },
  {
    method: 'get',
    route: '/api/w/:ws/posts/:postId',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/posts/${unknownId}`,
  },
  {
    method: 'patch',
    route: '/api/w/:ws/posts/:postId',
    permission: 'post.write',
    path: (i) => `/api/w/${i.slug}/posts/${unknownId}`,
    body: () => ({ version: 0, brief: 'Changed' }),
  },
  {
    method: 'delete',
    route: '/api/w/:ws/posts/:postId',
    permission: 'post.delete',
    path: (i) => `/api/w/${i.slug}/posts/${unknownId}`,
  },
  {
    method: 'patch',
    route: '/api/w/:ws/variants/:variantId',
    permission: 'post.write',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}`,
    body: () => ({ version: 0, text: 'Changed' }),
  },
  {
    method: 'get',
    route: '/api/w/:ws/styles',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/styles`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/styles',
    permission: 'brand_voice.manage',
    path: (i) => `/api/w/${i.slug}/styles`,
    body: (role) => ({ name: `Style of ${role}`, instructions: 'Short and warm.' }),
  },
  {
    method: 'patch',
    route: '/api/w/:ws/styles/:styleId',
    permission: 'brand_voice.manage',
    path: (i) => `/api/w/${i.slug}/styles/${unknownId}`,
    body: () => ({ version: 0, isActive: false }),
  },
  {
    method: 'get',
    route: '/api/w/:ws/brand-voices',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/brand-voices`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/brand-voices',
    permission: 'brand_voice.manage',
    path: (i) => `/api/w/${i.slug}/brand-voices`,
    body: (role) => ({ content: { name: `Voice of ${role}`, language: 'de' } }),
  },
  {
    method: 'patch',
    route: '/api/w/:ws/brand-voices/:brandVoiceId',
    permission: 'brand_voice.manage',
    path: (i) => `/api/w/${i.slug}/brand-voices/${unknownId}`,
    body: () => ({ version: 0, isDefault: true }),
  },
  {
    method: 'get',
    route: '/api/w/:ws/brand-voices/:brandVoiceId/versions',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/brand-voices/${unknownId}/versions`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/brand-voices/:brandVoiceId/test',
    permission: 'brand_voice.manage',
    path: (i) => `/api/w/${i.slug}/brand-voices/${unknownId}/test`,
    body: () => ({}),
  },
  {
    method: 'get',
    route: '/api/w/:ws/ideas',
    permission: 'idea.read',
    path: (i) => `/api/w/${i.slug}/ideas`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/ideas/generate',
    permission: 'ai.use',
    path: (i) => `/api/w/${i.slug}/ideas/generate`,
    body: () => ({ count: 1 }),
  },
  {
    method: 'patch',
    route: '/api/w/:ws/ideas/:ideaId',
    permission: 'idea.write',
    path: (i) => `/api/w/${i.slug}/ideas/${unknownId}`,
    body: () => ({ version: 0, status: 'SAVED' }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/ai/generations',
    permission: 'ai.use',
    path: (i) => `/api/w/${i.slug}/ai/generations`,
    body: () => ({ postId: unknownId }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/ai/refinements',
    permission: 'ai.use',
    path: (i) => `/api/w/${i.slug}/ai/refinements`,
    body: () => ({
      variantId: unknownId,
      action: 'shorter',
      current: { text: 'A text.', hashtags: [], firstComment: null },
    }),
  },
  {
    method: 'put',
    route: '/api/w/:ws/variants/:variantId/media',
    permission: 'post.write',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/media`,
    body: () => ({ version: 0, items: [] }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/media/uploads',
    permission: 'media.write',
    path: (i) => `/api/w/${i.slug}/media/uploads`,
    // A type the API refuses: allowed roles get 422, and nothing is created.
    body: () => ({ fileName: 'logo.svg', mimeType: 'image/svg+xml', size: 100 }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/media/:assetId/complete',
    permission: 'media.write',
    path: (i) => `/api/w/${i.slug}/media/${unknownId}/complete`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/media',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/media`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/media/:assetId',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/media/${unknownId}`,
  },
  {
    method: 'patch',
    route: '/api/w/:ws/media/:assetId',
    permission: 'media.write',
    path: (i) => `/api/w/${i.slug}/media/${unknownId}`,
    body: () => ({ version: 0, altText: 'A description.' }),
  },
  {
    method: 'delete',
    route: '/api/w/:ws/media/:assetId',
    permission: 'media.write',
    path: (i) => `/api/w/${i.slug}/media/${unknownId}`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/ai/alt-texts',
    permission: 'ai.use',
    path: (i) => `/api/w/${i.slug}/ai/alt-texts`,
    body: () => ({ assetId: unknownId }),
  },
  // Channels (guide step 4.5): an unknown platform, pending connection or account.
  {
    method: 'get',
    route: '/api/w/:ws/channels',
    permission: 'workspace.read',
    path: (i) => `/api/w/${i.slug}/channels`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/channels/:platform/connect',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/channels/myspace/connect`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/channels/pending/:pendingId',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/channels/pending/${unknownId}`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/channels/pending/:pendingId/confirm',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/channels/pending/${unknownId}/confirm`,
    body: () => ({ externalIds: ['urn:li:person:unknown'] }),
  },
  {
    method: 'get',
    route: '/api/w/:ws/accounts',
    permission: 'workspace.read',
    path: (i) => `/api/w/${i.slug}/accounts`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/accounts/:accountId/reconnect',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/accounts/${unknownId}/reconnect`,
  },
  {
    method: 'delete',
    route: '/api/w/:ws/accounts/:accountId',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/accounts/${unknownId}`,
  },
  // Planning and publishing (guide step 4.6): an unknown variant.
  {
    method: 'post',
    route: '/api/w/:ws/variants/:variantId/schedule',
    permission: 'post.schedule',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/schedule`,
    body: () => ({ version: 0, localDateTime: '2030-01-07T09:30', timeZone: 'Europe/Berlin' }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/variants/:variantId/reschedule',
    permission: 'post.schedule',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/reschedule`,
    body: () => ({ version: 0, localDateTime: '2030-01-07T10:30', timeZone: 'Europe/Berlin' }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/variants/:variantId/cancel',
    permission: 'post.schedule',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/cancel`,
    body: () => ({ version: 0 }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/variants/:variantId/publish-now',
    permission: 'post.publish',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/publish-now`,
    body: () => ({ version: 0, timeZone: 'Europe/Berlin' }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/variants/:variantId/retry',
    permission: 'post.schedule',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/retry`,
    body: () => ({ version: 0, timeZone: 'Europe/Berlin' }),
  },
  {
    method: 'post',
    route: '/api/w/:ws/variants/:variantId/resolve',
    permission: 'post.schedule',
    path: (i) => `/api/w/${i.slug}/variants/${unknownId}/resolve`,
    body: () => ({ version: 0, action: 'recheck' }),
  },
  // Destructive for everyone who may leave: last.
  {
    method: 'post',
    route: '/api/org/:org/leave',
    permission: 'org.read',
    path: (i) => `/api/org/${i.organizationId}/leave`,
  },
];

describe('permission matrix', () => {
  let api: ApiTestApp | undefined;
  const browsers = new Map<Role, Browser>();
  const ids = { organizationId: '', slug: DEMO_WORKSPACE_SLUG };

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    const system = createPrismaClient(api.database.url('app_system'));
    try {
      ids.organizationId = (await seedDemoData(system, SEED_PASSWORD)).organizationId;
    } finally {
      await system.$disconnect();
    }
    for (const user of DEMO_USERS) {
      browsers.set(user.role, await signIn(api, user.email, SEED_PASSWORD));
    }
  });

  afterAll(async () => {
    await api?.close();
  });

  it('covers every route that requires a permission', () => {
    const routes = started()
      .app.get(RouteAccessCheck)
      .routes.filter((route) => route.access === 'permission')
      .map((route) => `${route.method} ${route.path} ${route.permission ?? ''}`)
      .sort();
    const covered = ENDPOINTS.map(
      (endpoint) => `${endpoint.method.toUpperCase()} ${endpoint.route} ${endpoint.permission}`,
    ).sort();
    expect(covered).toEqual(routes);
  });

  for (const endpoint of ENDPOINTS) {
    for (const role of ROLES) {
      const allowed = can(role, endpoint.permission);
      it(`${endpoint.method.toUpperCase()} ${endpoint.route} as ${role}: ${allowed ? 'allowed' : '403'}`, async () => {
        const agent = browsers.get(role);
        if (!agent) {
          throw new Error(`no session for ${role}`);
        }
        const call = agent[endpoint.method](endpoint.path(ids));
        const response = await (endpoint.body ? call.send(endpoint.body(role)) : call);

        if (allowed) {
          expect(response.status, JSON.stringify(response.body)).not.toBe(403);
          expect(response.status).toBeLessThan(500);
        } else {
          expect(response.status).toBe(403);
          expect(response.body).toMatchObject({ code: 'NOT_PERMITTED' });
        }
      });
    }
  }
});
