import { createHmac } from 'node:crypto';

// A fake of the Graph API and the local media storage for the tests of the Meta adapters. Its
// answers follow the shapes of the documentation (see the sources in the adapters). Tokens that
// start with "fail-" make every Graph call fail: fail-<status> or fail-<status>-<retry-after>.

export const FAKE_APP = { appId: '123456789012345', appSecret: 'fake-app-secret-0123456789abcdef' };
export const FAKE_STORAGE = 'http://localhost:8333';
export const FAKE_PAGE_ID = '200000000000001';
export const FAKE_IG_USER_ID = '17841400000000001';

export interface RecordedCall {
  method: string;
  host: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  form: URLSearchParams | null;
  multipart: FormData | null;
}

interface PagePost {
  id: string;
  message: string;
  created: Date;
  published: boolean;
  deleted: boolean;
}

interface Container {
  id: string;
  params: Record<string, string>;
  statuses: string[];
}

interface IgMedia {
  id: string;
  caption: string;
  created: Date;
  deleted: boolean;
}

interface InjectedError {
  method: string;
  pathPattern: RegExp;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  times: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const graphError = (code: number, subcode?: number): unknown => ({
  error: {
    message: 'fake graph error',
    type: 'OAuthException',
    code,
    ...(subcode === undefined ? {} : { error_subcode: subcode }),
    fbtrace_id: 'Afake',
  },
});

const missing = (): Response => json(400, graphError(100, 33));

const graphTime = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, '+0000');

export class FakeGraph {
  readonly calls: RecordedCall[] = [];
  readonly posts = new Map<string, PagePost>();
  readonly photos = new Map<string, { published: boolean; bytes: number }>();
  readonly containers = new Map<string, Container>();
  readonly media = new Map<string, IgMedia>();
  readonly storage = new Map<string, Uint8Array>();
  readonly errors: InjectedError[] = [];
  /** The statuses a new container answers with, one per look; the last one repeats. */
  containerStatuses: string[] = ['FINISHED'];
  quotaUsage = 0;
  quotaTotal: number | undefined = 50;
  pageInsights = true;
  configIssue: string | undefined;
  pages: unknown[] = [
    {
      id: FAKE_PAGE_ID,
      name: 'Nordlicht Haustechnik',
      access_token: 'page-token-1',
      tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'],
      picture: { data: { url: 'https://scontent.example.com/p.jpg' } },
      instagram_business_account: {
        id: FAKE_IG_USER_ID,
        username: 'nordlicht.haustechnik',
        name: 'Nordlicht',
        profile_picture_url: 'https://scontent.example.com/ig.jpg',
      },
    },
    {
      id: '200000000000002',
      name: 'Nur Analyse',
      access_token: 'page-token-2',
      tasks: ['ANALYZE'],
    },
    {
      id: '200000000000003',
      name: 'Ohne Instagram',
      access_token: 'page-token-3',
      tasks: ['CREATE_CONTENT'],
    },
  ];
  granted = ['pages_show_list', 'pages_manage_posts', 'public_profile'];

  private sequence = 1000;

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Puts a file into the fake storage and returns its signed URL. */
  store(name: string, bytes: Uint8Array): string {
    const url = `${FAKE_STORAGE}/media/${name}?X-Amz-Signature=secret-signature`;
    this.storage.set(`/media/${name}`, bytes);
    return url;
  }

  failNext(
    method: string,
    pathPattern: RegExp,
    status: number,
    body: unknown,
    headers?: Record<string, string>,
  ): void {
    this.errors.push({ method, pathPattern, status, body, headers, times: 1 });
  }

  callsTo(method: string, pathPattern: RegExp): RecordedCall[] {
    return this.calls.filter((call) => call.method === method && pathPattern.test(call.path));
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === FAKE_STORAGE) {
      const bytes = this.storage.get(url.pathname);
      return bytes === undefined
        ? new Response('not found', { status: 404 })
        : new Response(new Uint8Array(bytes));
    }
    if (url.host !== 'graph.facebook.com') {
      return new Response('unknown host', { status: 502 });
    }
    const contentType = request.headers.get('content-type') ?? '';
    const call: RecordedCall = {
      method: request.method,
      host: url.host,
      path: url.pathname.replace(/^\/v\d+\.\d+/, ''),
      query: url.searchParams,
      headers: request.headers,
      form: contentType.startsWith('application/x-www-form-urlencoded')
        ? new URLSearchParams(await request.text())
        : null,
      multipart: contentType.startsWith('multipart/form-data') ? await request.formData() : null,
    };
    this.calls.push(call);
    return this.answer(call);
  };

  private answer(call: RecordedCall): Response {
    const token = /^Bearer (.+)$/.exec(call.headers.get('authorization') ?? '')?.[1];
    if (token !== undefined) {
      const proof = createHmac('sha256', FAKE_APP.appSecret).update(token).digest('hex');
      if (call.query.get('appsecret_proof') !== proof) {
        return json(400, graphError(100));
      }
      const fail = /^fail-(\d{3})(?:-(\d+))?/.exec(token);
      if (fail?.[1] !== undefined) {
        return json(Number(fail[1]), {}, fail[2] === undefined ? {} : { 'retry-after': fail[2] });
      }
    }
    const injected = this.errors.find(
      (error) => error.times > 0 && error.method === call.method && error.pathPattern.test(call.path),
    );
    if (injected) {
      injected.times -= 1;
      return json(injected.status, injected.body, injected.headers);
    }
    const value = (name: string): string =>
      call.form?.get(name) ?? (call.multipart?.get(name) as string | null) ?? '';
    const segments = call.path.split('/').filter(Boolean);
    const [first, second] = segments;

    if (call.path === '/oauth/access_token') {
      if (call.query.get('client_secret') !== FAKE_APP.appSecret) {
        return json(400, graphError(1));
      }
      if (call.query.get('grant_type') === 'fb_exchange_token') {
        return json(200, { access_token: 'long-user-token', token_type: 'bearer', expires_in: 5_183_944 });
      }
      return call.query.get('code') === 'good-code'
        ? json(200, { access_token: 'short-user-token', token_type: 'bearer', expires_in: 3600 })
        : json(400, graphError(100));
    }
    if (call.path === '/me') {
      return json(200, { id: '900000000000001', name: 'Mira Meta' });
    }
    if (call.path === '/me/permissions') {
      if (call.method === 'DELETE') {
        return json(200, { success: true });
      }
      return json(200, {
        data: [
          ...this.granted.map((permission) => ({ permission, status: 'granted' })),
          { permission: 'read_insights', status: 'declined' },
        ],
      });
    }
    if (call.path === '/me/accounts') {
      return json(200, { data: this.pages, paging: { cursors: { before: 'b', after: 'a' } } });
    }

    if (first === FAKE_PAGE_ID) {
      return this.page(call, second, value);
    }
    if (first === FAKE_IG_USER_ID) {
      return this.instagramUser(call, second, value);
    }
    if (first !== undefined) {
      return this.object(call, first, second);
    }
    return json(404, graphError(803));
  }

  private page(call: RecordedCall, edge: string | undefined, value: (name: string) => string): Response {
    if (edge === 'feed' && call.method === 'POST') {
      const attached = [...(call.form?.keys() ?? [])].filter((key) => key.startsWith('attached_media['));
      for (const key of attached) {
        const fbid = (JSON.parse(value(key)) as { media_fbid: string }).media_fbid;
        if (!this.photos.has(fbid)) {
          return json(400, graphError(100));
        }
      }
      const id = this.postOf(value('message'));
      return json(200, { id });
    }
    if (edge === 'feed' && call.method === 'GET') {
      const since = Number(call.query.get('since') ?? '0') * 1000;
      const data = [...this.posts.values()]
        .filter((post) => !post.deleted && post.created.getTime() >= since)
        .reverse()
        .map((post) => ({
          id: post.id,
          message: post.message,
          created_time: graphTime(post.created),
          permalink_url: `https://www.facebook.com/${post.id}`,
          is_published: post.published,
        }));
      return json(200, { data });
    }
    if (edge === 'photos' && call.method === 'POST') {
      const source = call.multipart?.get('source');
      if (!(source instanceof Blob)) {
        return json(400, graphError(324));
      }
      const id = this.nextId();
      const published = value('published') !== 'false';
      this.photos.set(id, { published, bytes: source.size });
      return json(200, published ? { id, post_id: this.postOf(value('caption')) } : { id });
    }
    if (edge === 'insights') {
      return this.pageInsights
        ? json(200, {
            data: [
              { name: 'page_total_media_view_unique', period: 'day', values: [{ value: 40 }, { value: 42 }] },
              { name: 'page_views_total', period: 'day', values: [{ value: 7 }] },
            ],
          })
        : json(400, graphError(100));
    }
    if (edge === undefined) {
      return json(200, { id: FAKE_PAGE_ID, followers_count: 321, fan_count: 300 });
    }
    return json(404, graphError(803));
  }

  private instagramUser(
    call: RecordedCall,
    edge: string | undefined,
    value: (name: string) => string,
  ): Response {
    if (edge === 'content_publishing_limit') {
      return json(200, {
        data: [
          {
            quota_usage: this.quotaUsage,
            ...(this.quotaTotal === undefined
              ? {}
              : { config: { quota_total: this.quotaTotal, quota_duration: 86400 } }),
          },
        ],
      });
    }
    if (edge === 'media' && call.method === 'POST') {
      const params = Object.fromEntries(call.form?.entries() ?? []);
      if (params.media_type === 'CAROUSEL') {
        for (const child of (params.children ?? '').split(',')) {
          if (!this.containers.has(child)) {
            return json(400, graphError(100));
          }
        }
      } else if (!params.image_url?.startsWith('https://')) {
        return json(400, graphError(9004, 2207052));
      }
      const id = this.nextId();
      this.containers.set(id, { id, params, statuses: [...this.containerStatuses] });
      return json(200, { id });
    }
    if (edge === 'media' && call.method === 'GET') {
      const since = Number(call.query.get('since') ?? '0') * 1000;
      const data = [...this.media.values()]
        .filter((item) => !item.deleted && item.created.getTime() >= since)
        .reverse()
        .map((item) => ({
          id: item.id,
          caption: item.caption,
          timestamp: graphTime(item.created),
          permalink: `https://www.instagram.com/p/${item.id}/`,
        }));
      return json(200, { data });
    }
    if (edge === 'media_publish') {
      const container = this.containers.get(value('creation_id'));
      if (!container || container.statuses[0] !== 'FINISHED') {
        return json(400, graphError(9007, 2207027));
      }
      const id = this.nextId();
      this.media.set(id, {
        id,
        caption: container.params.caption ?? '',
        created: this.now(),
        deleted: false,
      });
      return json(200, { id, ...(this.configIssue === undefined ? {} : { config_issue: this.configIssue }) });
    }
    if (edge === 'insights') {
      return json(200, {
        data: [
          {
            name: 'reach',
            period: 'day',
            total_value: { value: 224 },
            id: `${FAKE_IG_USER_ID}/insights/reach/day`,
          },
        ],
      });
    }
    if (edge === undefined) {
      return json(200, { id: FAKE_IG_USER_ID, followers_count: 1234 });
    }
    return json(404, graphError(803));
  }

  private object(call: RecordedCall, id: string, edge: string | undefined): Response {
    const post = this.posts.get(id);
    const item = this.media.get(id);
    const container = this.containers.get(id);
    if (call.method === 'DELETE') {
      if (post && !post.deleted) {
        post.deleted = true;
        return json(200, { success: true });
      }
      if (item && !item.deleted) {
        item.deleted = true;
        return json(200, { success: true, deleted_id: id });
      }
      return missing();
    }
    if (container && edge === undefined) {
      const status = container.statuses.length > 1 ? container.statuses.shift() : container.statuses[0];
      return json(200, {
        id,
        status_code: status,
        ...(status === 'ERROR' ? { status: 'Error: 2207052' } : {}),
      });
    }
    if (post && !post.deleted) {
      if (edge === 'insights') {
        return json(200, {
          data: [
            { name: 'post_media_view', period: 'lifetime', values: [{ value: 150 }] },
            { name: 'post_total_media_view_unique', period: 'lifetime', values: [{ value: 120 }] },
            { name: 'post_clicks', period: 'lifetime', values: [{ value: 9 }] },
          ],
        });
      }
      return json(200, {
        id,
        comments: { data: [], summary: { order: 'ranked', total_count: 3, can_comment: true } },
        reactions: { data: [], summary: { total_count: 12, viewer_reaction: 'NONE' } },
      });
    }
    if (item && !item.deleted) {
      if (edge === 'insights') {
        return json(200, {
          data: [
            { name: 'views', period: 'lifetime', values: [{ value: 500 }] },
            { name: 'reach', period: 'lifetime', values: [{ value: 400 }] },
            { name: 'likes', period: 'lifetime', values: [{ value: 30 }] },
            { name: 'comments', period: 'lifetime', values: [{ value: 4 }] },
            { name: 'saved', period: 'lifetime', values: [{ value: 6 }] },
          ],
        });
      }
      return json(200, {
        id,
        permalink: `https://www.instagram.com/p/${id}/`,
        timestamp: graphTime(item.created),
      });
    }
    return missing();
  }

  private postOf(message: string): string {
    const id = `${FAKE_PAGE_ID}_${this.nextId()}`;
    this.posts.set(id, { id, message, created: this.now(), published: true, deleted: false });
    return id;
  }

  private nextId(): string {
    this.sequence += 1;
    return `1789${String(this.sequence)}`;
  }
}
