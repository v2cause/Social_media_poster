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
  method: 'get' | 'post' | 'patch' | 'delete';
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
