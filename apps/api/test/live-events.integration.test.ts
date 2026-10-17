import type { AddressInfo } from 'node:net';

import { liveEventDtoSchema, type LiveEventDto } from '@smp/contracts';
import { createPrismaClient, DEMO_USERS, DEMO_WORKSPACE_SLUG, seedDemoData } from '@smp/db';
import { LiveEventPublisher } from '@smp/queue';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { APP_ORIGIN, startApiTestApp, type ApiTestApp } from './support/api-app';

// Guide step 4.10: GET /api/w/:ws/events passes the live events of its workspace to the browser
// as server-sent events: the status of variants to every member, a new notification to its user
// only. The access is checked when the stream opens.

const SEED_PASSWORD = 'seed-password-for-the-live-events-test';
const ws = `/api/w/${DEMO_WORKSPACE_SLUG}`;

const userOf = (role: string) => {
  const user = DEMO_USERS.find((candidate) => candidate.role === role);
  if (!user) {
    throw new Error(`no demo user with role ${role}`);
  }
  return user;
};

/** An open stream that collects its events. */
interface Stream {
  events: LiveEventDto[];
  /** Waits until the stream holds this many events. */
  waitFor: (count: number) => Promise<LiveEventDto[]>;
  close: () => void;
}

describe('live events API', () => {
  let api: ApiTestApp | undefined;
  let redis: Redis | undefined;
  let base = '';
  const ids = { workspace: '', editor: '', viewer: '' };
  const cookies = new Map<string, string>();

  const started = () => {
    if (!api || !redis) {
      throw new Error('API is not running');
    }
    return { api, redis };
  };
  const headers = (address: string) => ({
    'Content-Type': 'application/json',
    Origin: APP_ORIGIN,
    'X-Real-IP': address,
  });
  const signIn = async (role: string, address: string): Promise<string> => {
    const session = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: headers(address),
      body: JSON.stringify({ email: userOf(role).email, password: SEED_PASSWORD }),
    });
    return session.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  };
  const open = async (
    role: string,
    path = `${ws}/events`,
  ): Promise<{ response: Response; abort: () => void }> => {
    const controller = new AbortController();
    const response = await fetch(`${base}${path}`, {
      headers: { Cookie: cookies.get(role) ?? '', Accept: 'text/event-stream' },
      signal: controller.signal,
    });
    return {
      response,
      abort: () => {
        controller.abort();
      },
    };
  };
  const stream = async (role: string): Promise<Stream> => {
    const { response, abort } = await open(role);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toMatch(/^text\/event-stream/);
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('no body');
    }
    const events: LiveEventDto[] = [];
    const decoder = new TextDecoder();
    let buffer = '';
    let first = true;
    const read = async (): Promise<void> => {
      for (;;) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done) {
          return;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        let end = buffer.indexOf('\n\n');
        while (end >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (first) {
            expect(block).toBe('retry: 5000');
            first = false;
          } else if (!block.startsWith(':')) {
            const name = /^event: (.+)$/m.exec(block)?.[1];
            const event = liveEventDtoSchema.parse(JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? '{}'));
            expect(event.type).toBe(name);
            events.push(event);
          }
          end = buffer.indexOf('\n\n');
        }
      }
    };
    void read();
    return {
      events,
      waitFor: async (count) => {
        for (let waited = 0; events.length < count && waited < 5_000; waited += 50) {
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return events;
      },
      close: abort,
    };
  };
  /** Publishes like the worker does, once the streams subscribed. */
  const publish = async (workspaceId: string, event: Parameters<LiveEventPublisher['publish']>[1]) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await new LiveEventPublisher(started().redis).publish(workspaceId, event);
  };

  beforeAll(async () => {
    api = await startApiTestApp();
    redis = new Redis(api.env.REDIS_URL);
    await new Promise<void>((resolve) => api?.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${String((api.server.address() as AddressInfo).port)}`;
    const system = createPrismaClient(api.database.url('app_system'));
    try {
      ids.workspace = (await seedDemoData(system, SEED_PASSWORD)).workspaceId;
      for (const role of ['EDITOR', 'VIEWER'] as const) {
        const user = await system.user.findUniqueOrThrow({ where: { email: userOf(role).email } });
        ids[role === 'EDITOR' ? 'editor' : 'viewer'] = user.id;
      }
    } finally {
      await system.$disconnect();
    }
    cookies.set('EDITOR', await signIn('EDITOR', '192.0.2.201'));
    cookies.set('VIEWER', await signIn('VIEWER', '192.0.2.202'));
  }, 300_000);

  afterAll(async () => {
    redis?.disconnect();
    await api?.close();
  });

  it('passes the status of variants to every member and a notification to its user only', async () => {
    const editor = await stream('EDITOR');
    const viewer = await stream('VIEWER');
    const variant = {
      type: 'variant.status' as const,
      variantId: '0192f5d4-0000-7000-8000-000000000001',
      postId: '0192f5d4-0000-7000-8000-000000000002',
      status: 'PUBLISHED',
      scheduleVersion: 3,
    };
    try {
      await publish(ids.workspace, variant);
      await publish(ids.workspace, {
        type: 'notification.created',
        id: '0192f5d4-0000-7000-8000-000000000003',
        userId: ids.editor,
      });
      // Another workspace stays silent.
      await publish('0192f5d4-0000-7000-8000-000000000009', { ...variant, status: 'FAILED' });

      expect(await editor.waitFor(2)).toEqual([
        variant,
        { type: 'notification.created', id: '0192f5d4-0000-7000-8000-000000000003' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(viewer.events).toEqual([variant]);
    } finally {
      editor.close();
      viewer.close();
    }
  });

  it('opens a stream only with access to the workspace', async () => {
    const anonymous = await fetch(`${base}${ws}/events`);
    expect(anonymous.status).toBe(401);
    const foreign = await open('EDITOR', '/api/w/no-such-workspace/events');
    expect(foreign.response.status).toBe(404);
    foreign.abort();
  });
});
