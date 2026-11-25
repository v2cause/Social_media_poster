// Test support only, not exported from the package: a fake of the X API v2 and the local storage
// as a fetch function, for the unit tests and the contract suite of the X adapter. Its answers
// follow the shapes of the docs (checked 2026-11-25): token answer
// (https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange), problem
// details and partial errors (https://docs.x.com/x-api/fundamentals/response-codes-and-errors),
// public_metrics (https://docs.x.com/x-api/fundamentals/metrics), the media and post operations of
// https://docs.x.com/openapi.json 2.175. The duplicate answer is the one seen in practice; the docs
// do not document it.
//
// An access token "fail-<status>[-<seconds>]" makes every API call answer that status, with
// Retry-After when seconds are given, as the contract suite asks.

export const FAKE_CLIENT_ID = 'Y2xpZW50LWlkLWZvci10ZXN0czox';
export const FAKE_CLIENT_SECRET = 'fake-client-secret-for-tests';
export const FAKE_USER = { id: '1460000000000000001', name: 'Mira Nordlicht', username: 'mira_nordlicht' };
export const STORAGE = 'http://localhost:9000';

export interface RecordedRequest {
  method: string;
  path: string;
  search: URLSearchParams;
  headers: Headers;
  body: string;
}

interface FakePost {
  id: string;
  text: string;
  createdAt: string;
  deleted: boolean;
  mediaIds: string[];
}

interface FakeUpload {
  id: string;
  totalBytes: number;
  received: number;
  category: string;
  finalized: boolean;
  polls: number;
  altText: string | null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

const problem = (status: number, title: string, detail: string, type = 'about:blank'): Response =>
  json({ title, detail, type, status }, status);

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export class FakeXApi {
  readonly requests: RecordedRequest[] = [];
  readonly posts: FakePost[] = [];
  readonly uploads = new Map<string, FakeUpload>();
  readonly storage = new Map<string, { bytes: Uint8Array; status?: number }>();
  /** Refresh tokens X still accepts; a used one is removed (single-use). */
  readonly liveRefreshTokens = new Set<string>(['refresh-initial']);
  readonly revoked: string[] = [];
  /** How many status polls a GIF needs before X reports succeeded. */
  gifPolls = 1;
  followers = 1234;
  private sequence = 1_870_000_000_000_000_000n;
  private issued = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    const body =
      typeof init?.body === 'string' ? init.body : init?.body ? await new Response(init.body).text() : '';
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path: url.pathname, search: url.searchParams, headers, body });
    if (url.origin === STORAGE) {
      return this.download(url.pathname);
    }
    return this.route(method, url, headers, body);
  };

  calls(method: string, path: string | RegExp): RecordedRequest[] {
    return this.requests.filter(
      (request) =>
        request.method === method &&
        (typeof path === 'string' ? request.path === path : path.test(request.path)),
    );
  }

  /** A post that exists on X already, for the reconcile. */
  seedPost(text: string, createdAt: Date, mediaIds: string[] = []): FakePost {
    const post = { id: this.nextId(), text, createdAt: createdAt.toISOString(), deleted: false, mediaIds };
    this.posts.push(post);
    return post;
  }

  private nextId(): string {
    this.sequence += 1n;
    return this.sequence.toString();
  }

  private download(path: string): Response {
    const file = this.storage.get(path);
    if (!file) {
      return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }
    return new Response(new Uint8Array(file.bytes), {
      status: file.status ?? 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(file.bytes.byteLength) },
    });
  }

  private route(method: string, url: URL, headers: Headers, body: string): Response {
    const path = url.pathname;
    if (path === '/2/oauth2/token' && method === 'POST') {
      return this.token(headers, new URLSearchParams(body));
    }
    if (path === '/2/oauth2/revoke' && method === 'POST') {
      if (!this.basicOk(headers)) {
        return json(
          { error: 'invalid_client', error_description: 'Missing valid authorization header' },
          401,
        );
      }
      this.revoked.push(new URLSearchParams(body).get('token') ?? '');
      return json({ revoked: true });
    }

    const token = (headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const failure = /^fail-(\d{3})(?:-(\d+))?$/.exec(token);
    if (failure) {
      const status = Number(failure[1]);
      const extra: Record<string, string> = failure[2] ? { 'retry-after': failure[2] } : {};
      return json(
        { title: 'Failure', detail: 'Injected failure', type: 'about:blank', status },
        status,
        extra,
      );
    }
    if (!token.startsWith('access-')) {
      return json({ title: 'Unauthorized', type: 'about:blank', status: 401, detail: 'Unauthorized' }, 401);
    }

    if (path === '/2/users/me' && method === 'GET') {
      return json({
        data: {
          ...FAKE_USER,
          profile_image_url: 'https://pbs.twimg.com/profile_images/1/mira_normal.jpg',
          public_metrics: {
            followers_count: this.followers,
            following_count: 87,
            post_count: this.posts.length,
            listed_count: 3,
            like_count: 410,
            media_count: 12,
          },
        },
      });
    }
    if (path === '/2/media/upload/initialize' && method === 'POST') {
      const input = JSON.parse(body) as { media_category: string; media_type: string; total_bytes: number };
      const id = this.nextId();
      this.uploads.set(id, {
        id,
        totalBytes: input.total_bytes,
        received: 0,
        category: input.media_category,
        finalized: false,
        polls: 0,
        altText: null,
      });
      return json({ data: { id, media_key: `3_${id}`, expires_after_secs: 86_400 } });
    }
    const append = /^\/2\/media\/upload\/(\d+)\/append$/.exec(path);
    if (append && method === 'POST') {
      const upload = this.uploads.get(append[1] ?? '');
      if (!upload) {
        return problem(
          400,
          'Invalid Request',
          'Unknown upload',
          'https://api.x.com/2/problems/invalid-request',
        );
      }
      const input = JSON.parse(body) as { media: string; segment_index: number };
      upload.received += Buffer.from(input.media, 'base64').byteLength;
      return json({ data: { expires_at: 1_800_000_000 } });
    }
    const finalize = /^\/2\/media\/upload\/(\d+)\/finalize$/.exec(path);
    if (finalize && method === 'POST') {
      const upload = this.uploads.get(finalize[1] ?? '');
      if (upload?.received !== upload?.totalBytes || !upload) {
        return problem(
          400,
          'Invalid Request',
          'Segments missing',
          'https://api.x.com/2/problems/invalid-request',
        );
      }
      upload.finalized = true;
      return json({ data: this.mediaStatus(upload) });
    }
    if (path === '/2/media/upload' && method === 'GET') {
      const upload = this.uploads.get(url.searchParams.get('media_id') ?? '');
      if (!upload) {
        return problem(
          400,
          'Invalid Request',
          'Unknown media',
          'https://api.x.com/2/problems/invalid-request',
        );
      }
      upload.polls += 1;
      return json({ data: this.mediaStatus(upload) });
    }
    if (path === '/2/media/metadata' && method === 'POST') {
      const input = JSON.parse(body) as { id: string; metadata: { alt_text?: { text: string } } };
      const upload = this.uploads.get(input.id);
      if (!upload) {
        return problem(
          400,
          'Invalid Request',
          'Unknown media',
          'https://api.x.com/2/problems/invalid-request',
        );
      }
      upload.altText = input.metadata.alt_text?.text ?? null;
      return json({ data: { id: input.id, associated_metadata: input.metadata } });
    }
    if (path === '/2/tweets' && method === 'POST') {
      return this.createPost(JSON.parse(body) as { text: string; media?: { media_ids: string[] } });
    }
    const single = /^\/2\/tweets\/(\d+)$/.exec(path);
    if (single && method === 'DELETE') {
      const post = this.posts.find((candidate) => candidate.id === single[1] && !candidate.deleted);
      if (!post) {
        return problem(
          404,
          'Not Found Error',
          'Could not find the Post.',
          'https://api.x.com/2/problems/resource-not-found',
        );
      }
      post.deleted = true;
      return json({ data: { deleted: true } });
    }
    const own = /^\/2\/users\/(\d+)\/tweets$/.exec(path);
    if (own && method === 'GET') {
      const max = Number(url.searchParams.get('max_results') ?? '10');
      const latest = this.posts
        .filter((post) => !post.deleted)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, max);
      return json(
        latest.length === 0
          ? { meta: { result_count: 0 } }
          : {
              data: latest.map((post) => ({
                id: post.id,
                text: this.renderText(post),
                created_at: post.createdAt,
                edit_history_tweet_ids: [post.id],
              })),
              meta: { result_count: latest.length, newest_id: latest[0]?.id, oldest_id: latest.at(-1)?.id },
            },
      );
    }
    if (path === '/2/tweets' && method === 'GET') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter((id) => id.length > 0);
      const data = [];
      const errors = [];
      for (const id of ids) {
        const post = this.posts.find((candidate) => candidate.id === id && !candidate.deleted);
        if (post) {
          data.push({
            id: post.id,
            text: this.renderText(post),
            created_at: post.createdAt,
            edit_history_tweet_ids: [post.id],
            public_metrics: {
              retweet_count: 4,
              reply_count: 2,
              like_count: 31,
              quote_count: 1,
              bookmark_count: 3,
              impression_count: 1520,
            },
          });
        } else {
          errors.push({
            value: id,
            detail: `Could not find tweet with ids: [${id}].`,
            title: 'Not Found Error',
            resource_type: 'tweet',
            parameter: 'ids',
            resource_id: id,
            type: 'https://api.twitter.com/2/problems/resource-not-found',
          });
        }
      }
      return json({ ...(data.length > 0 ? { data } : {}), ...(errors.length > 0 ? { errors } : {}) });
    }
    return problem(404, 'Not Found', `No route for ${method} ${path}`);
  }

  private token(headers: Headers, form: URLSearchParams): Response {
    if (!this.basicOk(headers)) {
      return json({ error: 'invalid_client', error_description: 'Missing valid authorization header' }, 401);
    }
    const grantType = form.get('grant_type');
    if (grantType === 'authorization_code') {
      if (form.get('code') !== 'code-ok' || !form.get('code_verifier') || !form.get('redirect_uri')) {
        return json(
          {
            error: 'invalid_request',
            error_description: 'Value passed for the authorization code was invalid.',
          },
          400,
        );
      }
    } else if (grantType === 'refresh_token') {
      const refresh = form.get('refresh_token') ?? '';
      if (!this.liveRefreshTokens.delete(refresh)) {
        return json(
          { error: 'invalid_grant', error_description: 'Value passed for the token was invalid.' },
          400,
        );
      }
    } else {
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    this.issued += 1;
    const refreshToken = `refresh-${String(this.issued)}`;
    this.liveRefreshTokens.add(refreshToken);
    return json({
      token_type: 'bearer',
      expires_in: 7200,
      access_token: `access-${String(this.issued)}`,
      scope: 'tweet.write users.read tweet.read offline.access media.write',
      refresh_token: refreshToken,
    });
  }

  private basicOk(headers: Headers): boolean {
    const expected = `Basic ${Buffer.from(`${FAKE_CLIENT_ID}:${FAKE_CLIENT_SECRET}`).toString('base64')}`;
    return headers.get('authorization') === expected;
  }

  private mediaStatus(upload: FakeUpload): Record<string, unknown> {
    const base = {
      id: upload.id,
      media_key: `3_${upload.id}`,
      size: upload.totalBytes,
      expires_after_secs: 86_400,
    };
    if (upload.category !== 'tweet_gif') {
      return { ...base, image: { image_type: 'image/jpeg', w: 1200, h: 675 } };
    }
    return upload.polls >= this.gifPolls
      ? { ...base, processing_info: { state: 'succeeded', progress_percent: 100 } }
      : { ...base, processing_info: { state: 'in_progress', check_after_secs: 1, progress_percent: 40 } };
  }

  private createPost(input: { text: string; media?: { media_ids: string[] } }): Response {
    const mediaIds = input.media?.media_ids ?? [];
    if (mediaIds.some((id) => !this.uploads.get(id)?.finalized)) {
      return problem(
        400,
        'Invalid Request',
        'Your media IDs are invalid.',
        'https://api.x.com/2/problems/invalid-request',
      );
    }
    if (this.posts.some((post) => !post.deleted && post.text === input.text)) {
      return problem(403, 'Forbidden', 'You are not allowed to create a Tweet with duplicate content.');
    }
    const post = this.seedPost(input.text, new Date(), mediaIds);
    return json(
      { data: { id: post.id, text: this.renderText(post), edit_history_post_ids: [post.id] } },
      201,
    );
  }

  /** The text as X returns it: entities escaped, URLs as t.co, a t.co link for the media. */
  private renderText(post: FakePost): string {
    const text = escapeHtml(post.text).replace(/https?:\/\/\S+/g, 'https://t.co/AbCdEf1234');
    return post.mediaIds.length > 0 ? `${text} https://t.co/MeDiA98765` : text;
  }
}
