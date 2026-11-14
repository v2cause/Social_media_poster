import { failureFor, fakeFetch, formOf, imageFor, json } from '../live/fake-platform';

// A fake of the X API v2 calls of the adapter (test support, guide step 4.14): OAuth 2.0 with
// rotating refresh tokens, media upload and alt text, posts, the timeline and the lookup with
// public metrics. Answer forms after the X docs as known from secondary sources (ADR 0046).

export const X_USER_ID = '1440000000000000001';

export interface FakeXPost {
  id: string;
  text: string;
  mediaIds: string[];
  createdAt: Date;
  deleted: boolean;
}

export class FakeX {
  readonly posts: FakeXPost[] = [];
  readonly media = new Map<string, { category: string; type: string; altText: string | null }>();
  /** Refresh tokens that are still good; each one is spent by its use. */
  readonly refreshTokens = new Set<string>(['refresh-1']);
  /** Answers the alt text with 400, like an API that refuses it. */
  refuseMetadata = false;
  private next = 1_850_000_000_000_000_000n;
  readonly client;

  constructor() {
    this.client = fakeFetch((request, url) => this.handle(request, url));
  }

  get requests(): Request[] {
    return this.client.requests;
  }

  private id(): string {
    this.next += 1n;
    return this.next.toString();
  }

  private async handle(request: Request, url: URL): Promise<Response> {
    const image = imageFor(url);
    if (image) {
      return image;
    }
    if (url.pathname === '/2/oauth2/token') {
      const form = await formOf(request);
      if (form.grant_type === 'refresh_token') {
        if (!this.refreshTokens.delete(form.refresh_token ?? '')) {
          return json(
            { error: 'invalid_request', error_description: 'Value passed for the token was invalid.' },
            400,
          );
        }
      }
      const refresh = `refresh-${this.id()}`;
      this.refreshTokens.add(refresh);
      return json({
        token_type: 'bearer',
        expires_in: 7200,
        access_token: `access-${this.id()}`,
        scope: 'tweet.read tweet.write users.read media.write offline.access',
        refresh_token: refresh,
      });
    }
    if (url.pathname === '/2/oauth2/revoke') {
      return json({ revoked: true });
    }
    const failure = failureFor(request, { title: 'Failure', detail: 'failure', status: 0 });
    if (failure) {
      return failure;
    }
    if (url.pathname === '/2/users/me') {
      return json({
        data: {
          id: X_USER_ID,
          name: 'Nordlicht Haustechnik',
          username: 'nordlicht_ht',
          public_metrics: { followers_count: 2048, following_count: 10, tweet_count: 40 },
        },
      });
    }
    if (url.pathname === '/2/media/upload' && request.method === 'POST') {
      const form = await formOf(request);
      if (!form.media_category || !form.media?.startsWith('file:')) {
        return json({ title: 'Invalid Request', detail: 'Missing media_category field' }, 400);
      }
      const id = this.id();
      this.media.set(id, { category: form.media_category, type: form.media_type ?? '', altText: null });
      return json({ data: { id, media_key: `3_${id}`, size: 6 } });
    }
    if (url.pathname === '/2/media/metadata' && this.refuseMetadata) {
      return json(
        { title: 'Invalid Request', detail: 'One or more parameters to your request was invalid.' },
        400,
      );
    }
    if (url.pathname === '/2/media/metadata') {
      const body = (await request.json()) as { id: string; metadata: { alt_text: { text: string } } };
      const entry = this.media.get(body.id);
      if (!entry) {
        return json({ title: 'Not Found' }, 404);
      }
      entry.altText = body.metadata.alt_text.text;
      return json({ data: { associated_metadata: true } });
    }
    if (url.pathname === '/2/tweets' && request.method === 'POST') {
      const body = (await request.json()) as { text: string; media?: { media_ids: string[] } };
      if (this.posts.some((post) => post.text === body.text && !post.deleted)) {
        return json(
          {
            detail: 'You are not allowed to create a Tweet with duplicate content.',
            type: 'about:blank',
            title: 'Forbidden',
            status: 403,
          },
          403,
        );
      }
      const post = {
        id: this.id(),
        text: body.text,
        mediaIds: body.media?.media_ids ?? [],
        createdAt: new Date(),
        deleted: false,
      };
      this.posts.push(post);
      return json({ data: { id: post.id, text: post.text, edit_history_tweet_ids: [post.id] } }, 201);
    }
    if (url.pathname === `/2/users/${X_USER_ID}/tweets`) {
      const max = Number(url.searchParams.get('max_results') ?? '10');
      const data = this.posts
        .filter((post) => !post.deleted)
        .reverse()
        .slice(0, max)
        .map((post) => ({ id: post.id, text: post.text, created_at: post.createdAt.toISOString() }));
      return json(
        data.length > 0 ? { data, meta: { result_count: data.length } } : { meta: { result_count: 0 } },
      );
    }
    if (url.pathname === '/2/tweets' && request.method === 'GET') {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      const found = this.posts.filter((post) => ids.includes(post.id) && !post.deleted);
      const missing = ids.filter((id) => !found.some((post) => post.id === id));
      return json({
        ...(found.length > 0
          ? {
              data: found.map((post) => ({
                id: post.id,
                text: post.text,
                public_metrics: {
                  retweet_count: 2,
                  reply_count: 1,
                  like_count: 9,
                  quote_count: 1,
                  bookmark_count: 3,
                  impression_count: 640,
                },
              })),
            }
          : {}),
        ...(missing.length > 0
          ? {
              errors: missing.map((id) => ({
                value: id,
                detail: `Could not find tweet with ids: [${id}].`,
                title: 'Not Found Error',
                resource_type: 'tweet',
                parameter: 'ids',
                resource_id: id,
                type: 'https://api.twitter.com/2/problems/resource-not-found',
              })),
            }
          : {}),
      });
    }
    if (url.pathname.startsWith('/2/tweets/') && request.method === 'DELETE') {
      const post = this.posts.find((entry) => entry.id === url.pathname.slice('/2/tweets/'.length));
      if (post) {
        post.deleted = true;
      }
      return json({ data: { deleted: post !== undefined } });
    }
    return json({ title: `no fake for ${request.method} ${url.pathname}` }, 501);
  }
}
