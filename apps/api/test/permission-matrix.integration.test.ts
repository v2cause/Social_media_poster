import { randomUUID } from 'node:crypto';

import { createStripeClient, syncCatalog } from '@smp/billing';
import { can, ROLES, X_BROWSER_RISK, type Permission, type Role } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { FakeStripe } from '@smp/testing';
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
  /** The route answers with a stream that stays open: the test reads the status and closes it. */
  stream?: true;
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
  // Billing (guide step 7.2): owners only, against the fake Stripe.
  {
    method: 'post',
    route: '/api/org/:org/billing/checkout',
    permission: 'billing.manage',
    path: (i) => `/api/org/${i.organizationId}/billing/checkout`,
    body: () => ({ plan: 'pro' }),
  },
  {
    method: 'post',
    route: '/api/org/:org/billing/plan',
    permission: 'billing.manage',
    path: (i) => `/api/org/${i.organizationId}/billing/plan`,
    body: () => ({ plan: 'pro' }),
  },
  {
    method: 'post',
    route: '/api/org/:org/billing/portal',
    permission: 'billing.manage',
    path: (i) => `/api/org/${i.organizationId}/billing/portal`,
  },
  {
    method: 'get',
    route: '/api/org/:org/billing/invoices',
    permission: 'billing.manage',
    path: (i) => `/api/org/${i.organizationId}/billing/invoices`,
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
  // The live events (guide step 4.10).
  {
    method: 'get',
    route: '/api/w/:ws/events',
    permission: 'workspace.read',
    path: (i) => `/api/w/${i.slug}/events`,
    stream: true,
  },
  // The variants for the calendar and the post list (guide step 4.11).
  {
    method: 'get',
    route: '/api/w/:ws/variants',
    permission: 'post.read',
    path: (i) => `/api/w/${i.slug}/variants?order=schedule`,
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
  // Analytics (guide step 5.4): every role reads; an unknown post or account is 404.
  {
    method: 'get',
    route: '/api/w/:ws/analytics/overview',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/overview`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/analytics/timeseries',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/timeseries?metric=followers&groupBy=account`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/analytics/top-posts',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/top-posts`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/analytics/breakdown',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/breakdown?by=style`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/analytics/posts/:variantId',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/posts/${unknownId}`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/analytics/accounts/:accountId',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/accounts/${unknownId}`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/analytics/export.csv',
    permission: 'analytics.read',
    path: (i) => `/api/w/${i.slug}/analytics/export.csv`,
  },
  {
    method: 'get',
    route: '/api/w/:ws/x-browser',
    permission: 'workspace.read',
    path: (i) => `/api/w/${i.slug}/x-browser`,
  },
  {
    // A wrong password: allowed roles get 422, the others 403.
    method: 'post',
    route: '/api/w/:ws/x-browser/activation',
    permission: 'x_browser.enable',
    path: (i) => `/api/w/${i.slug}/x-browser/activation`,
    body: () => ({
      version: X_BROWSER_RISK.version,
      locale: 'de',
      accepted: true,
      password: 'not-the-password',
    }),
  },
  {
    method: 'delete',
    route: '/api/w/:ws/x-browser/activation',
    permission: 'x_browser.enable',
    path: (i) => `/api/w/${i.slug}/x-browser/activation`,
  },
  {
    // The X browser is off in this deployment: allowed roles get 409.
    method: 'post',
    route: '/api/w/:ws/x-browser/login-sessions',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/x-browser/login-sessions`,
    body: () => ({ username: 'smp_demo', password: 'not-a-password', locale: 'de' }),
  },
  {
    method: 'get',
    route: '/api/w/:ws/x-browser/login-sessions/:loginId',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/x-browser/login-sessions/${unknownId}`,
  },
  {
    method: 'post',
    route: '/api/w/:ws/x-browser/login-sessions/:loginId/code',
    permission: 'account.manage',
    path: (i) => `/api/w/${i.slug}/x-browser/login-sessions/${unknownId}/code`,
    body: () => ({ code: '123456' }),
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
  let stripe: FakeStripe | undefined;
  const browsers = new Map<Role, Browser>();
  const ids = { organizationId: '', slug: DEMO_WORKSPACE_SLUG };

  const started = (): ApiTestApp => {
    if (!api) {
      throw new Error('API is not running');
    }
    return api;
  };

  beforeAll(async () => {
    stripe = await FakeStripe.start({ webhookSecret: 'whsec_matrix' });
    await syncCatalog(createStripeClient({ secretKey: 'sk_test_matrix', apiBase: stripe.url }));
    api = await startApiTestApp({
      env: {
        STRIPE_SECRET_KEY: 'sk_test_matrix',
        STRIPE_WEBHOOK_SECRET: 'whsec_matrix',
        STRIPE_API_BASE: stripe.url,
      },
    });
    // A server that already listens stays open between the calls. SuperTest would otherwise
    // close it after each call and wait for the open event streams.
    await new Promise<void>((resolve) => api?.server.listen(0, '127.0.0.1', resolve));
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
    await stripe?.close();
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
        const response = await (endpoint.body
          ? call.send(endpoint.body(role))
          : endpoint.stream
            ? call.buffer(false)
            : call);
        if (endpoint.stream) {
          // Closing the stream from this side ends its response with an error, which is expected.
          response.on('error', () => undefined);
          call.abort();
        }

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
