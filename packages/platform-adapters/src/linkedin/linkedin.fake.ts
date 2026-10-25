import { failureFor, fakeFetch, imageFor, json } from '../live/fake-platform';

// A fake of the LinkedIn calls the adapter makes (test support, guide step 4.12): OAuth, userinfo,
// organization ACLs, the Images API, the Posts API and the statistics of company pages. Answer
// forms after the LinkedIn docs as known from secondary sources (ADR 0046).

export interface FakeLinkedInPost {
  id: string;
  author: string;
  commentary: string;
  content: unknown;
  createdAt: number;
  deleted: boolean;
}

export class FakeLinkedIn {
  readonly posts: FakeLinkedInPost[] = [];
  readonly images = new Map<string, { status: string; uploaded: boolean; polls: number }>();
  readonly comments: { urn: string; body: unknown }[] = [];
  /** How many status polls an image stays PROCESSING. */
  processingPolls = 0;
  private next = 7_000_000;
  readonly client;

  constructor(private readonly version = '202510') {
    this.client = fakeFetch((request, url) => this.handle(request, url));
  }

  get requests(): Request[] {
    return this.client.requests;
  }

  private async handle(request: Request, url: URL): Promise<Response> {
    const image = imageFor(url);
    if (image) {
      return image;
    }
    if (url.host === 'www.linkedin.com' && url.pathname === '/oauth/v2/accessToken') {
      const form = new URLSearchParams(await request.text());
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === 'spent') {
        return json({ error: 'invalid_grant' }, 400);
      }
      return json({
        access_token: `access-${String(this.next++)}`,
        expires_in: 5_184_000,
        scope:
          'openid,profile,w_member_social,w_organization_social,r_organization_social,rw_organization_admin',
      });
    }
    if (url.host === 'www.linkedin.com' && url.pathname === '/oauth/v2/revoke') {
      return new Response(null, { status: 200 });
    }
    if (url.host === 'www.linkedin.com' && url.pathname.startsWith('/dms-uploads/')) {
      const urn = `urn:li:image:${url.pathname.slice('/dms-uploads/'.length)}`;
      const entry = this.images.get(urn);
      if (!entry || request.method !== 'PUT') {
        return json({ message: 'unknown upload' }, 404);
      }
      entry.uploaded = true;
      return new Response(null, { status: 201 });
    }
    const failure = failureFor(request);
    if (failure) {
      return failure;
    }
    if (url.pathname === '/v2/userinfo') {
      return json({ sub: 'Ab12Cd', name: 'Mira Nordlicht', given_name: 'Mira', family_name: 'Nordlicht' });
    }
    if (url.pathname.startsWith('/rest/') && request.headers.get('linkedin-version') !== this.version) {
      return json({ message: 'VERSION_MISSING', status: 426 }, 426);
    }
    if (url.pathname === '/rest/organizationAcls') {
      return json({
        elements: [
          { organization: 'urn:li:organization:1001', role: 'ADMINISTRATOR', state: 'APPROVED' },
          { organization: 'urn:li:organization:1002', role: 'ANALYST', state: 'APPROVED' },
        ],
      });
    }
    if (url.pathname.startsWith('/rest/organizations/')) {
      return json({ id: 1001, localizedName: 'Nordlicht Haustechnik', vanityName: 'nordlicht' });
    }
    if (url.pathname === '/rest/images' && url.searchParams.get('action') === 'initializeUpload') {
      const id = `D4E10AQ${String(this.next++)}`;
      this.images.set(`urn:li:image:${id}`, { status: 'PROCESSING', uploaded: false, polls: 0 });
      return json({
        value: {
          uploadUrlExpiresAt: Date.now() + 3_600_000,
          uploadUrl: `https://www.linkedin.com/dms-uploads/${id}`,
          image: `urn:li:image:${id}`,
        },
      });
    }
    if (url.pathname.startsWith('/rest/images/')) {
      const entry = this.images.get(decodeURIComponent(url.pathname.slice('/rest/images/'.length)));
      if (!entry) {
        return json({ message: 'not found' }, 404);
      }
      entry.polls += 1;
      const status = entry.uploaded && entry.polls > this.processingPolls ? 'AVAILABLE' : 'PROCESSING';
      return json({ status });
    }
    if (url.pathname === '/rest/posts' && request.method === 'POST') {
      return this.createPost(request);
    }
    if (url.pathname === '/rest/posts' && url.searchParams.get('q') === 'author') {
      const author = url.searchParams.get('author');
      const elements = this.posts
        .filter((post) => post.author === author && !post.deleted)
        .reverse()
        .map((post) => ({
          id: post.id,
          commentary: post.commentary,
          createdAt: post.createdAt,
          publishedAt: post.createdAt,
        }));
      return json({ elements });
    }
    if (url.pathname.startsWith('/rest/posts/')) {
      const post = this.posts.find(
        (entry) => entry.id === decodeURIComponent(url.pathname.slice('/rest/posts/'.length)),
      );
      if (!post || post.deleted) {
        return json({ message: 'Not Found' }, 404);
      }
      if (request.method === 'DELETE') {
        post.deleted = true;
        return new Response(null, { status: 204 });
      }
      return json({ id: post.id, commentary: post.commentary });
    }
    if (url.pathname.startsWith('/rest/socialActions/')) {
      this.comments.push({
        urn: decodeURIComponent(url.pathname.split('/')[3] ?? ''),
        body: await request.json(),
      });
      return new Response(null, { status: 201 });
    }
    if (url.pathname === '/rest/organizationalEntityShareStatistics') {
      const listed = (name: string): string[] =>
        (url.searchParams.get(name) ?? '')
          .replace(/^List\(|\)$/g, '')
          .split(',')
          .filter(Boolean);
      const wanted = [...listed('shares'), ...listed('ugcPosts')];
      const elements = this.posts
        .filter((post) => wanted.includes(post.id) && !post.deleted)
        .map((post) => ({
          share: post.id,
          totalShareStatistics: {
            impressionCount: 120,
            uniqueImpressionsCount: 90,
            clickCount: 4,
            likeCount: 7,
            commentCount: 2,
            shareCount: 1,
            engagement: 0.1,
          },
        }));
      return json({ elements });
    }
    if (url.pathname.startsWith('/rest/networkSizes/')) {
      return json({ firstDegreeSize: 1234 });
    }
    if (url.pathname === '/rest/memberCreatorPostAnalytics') {
      return json({ elements: [{ count: url.searchParams.get('queryType') === 'IMPRESSION' ? 300 : 5 }] });
    }
    return json({ message: `no fake for ${request.method} ${url.pathname}` }, 501);
  }

  private async createPost(request: Request): Promise<Response> {
    const body = (await request.json()) as { author: string; commentary: string; content?: unknown };
    if (request.headers.get('x-restli-protocol-version') !== '2.0.0') {
      return json({ message: 'protocol version missing' }, 400);
    }
    if (body.commentary.length > 3000) {
      return json({ message: 'FIELD_LENGTH_TOO_LONG' }, 422);
    }
    const duplicate = this.posts.find(
      (post) => post.author === body.author && post.commentary === body.commentary && !post.deleted,
    );
    if (duplicate && body.commentary.length > 0) {
      return json({ message: `Content is a duplicate of ${duplicate.id}`, status: 422 }, 422);
    }
    const id = `urn:li:share:${String(this.next++)}`;
    this.posts.push({
      id,
      author: body.author,
      commentary: body.commentary,
      content: body.content,
      createdAt: Date.now(),
      deleted: false,
    });
    return new Response(null, { status: 201, headers: { 'x-restli-id': id } });
  }
}
