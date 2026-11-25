// A fake LinkedIn for the tests of the adapter: a fetch that answers like the documented endpoints,
// with payloads shaped like the samples of the official documentation (checked 2026-11-25), and a
// fake storage that serves the renditions. An access token "fail-<status>[-<retry-after>]" makes
// every call answer with that status, which the contract suite uses.

export const FAKE_STORAGE_URL = 'http://localhost:9000/smp-media';
export const FAKE_PERSON_SUB = '782bbtaQ';
export const FAKE_PERSON_URN = `urn:li:person:${FAKE_PERSON_SUB}`;
export const FAKE_ORGANIZATION_URN = 'urn:li:organization:2414183';
export const FAKE_CLIENT_ID = '861hhm46p48to2';
export const FAKE_CLIENT_SECRET = 'gPecS7yqHkyyShvR';
export const FAKE_REDIRECT_URI = 'http://localhost:3000/api/oauth/linkedin/callback';
export const FAKE_CODE = 'AQTQmah11lalyH65DAIivsjsAQV5P';
export const FAKE_REFRESH_TOKEN = 'AQWAft_WjYZKwuWXLC5hQlghgTam';

/** The sample answer of GET /v2/userinfo (sign-in-with-linkedin-v2). */
export const USERINFO_FIXTURE = {
  sub: FAKE_PERSON_SUB,
  name: 'John Doe',
  given_name: 'John',
  family_name: 'Doe',
  picture: 'https://media.licdn-ei.com/dms/image/C5F03AQHqK8v7tB1HCQ/profile-displayphoto-shrink_100_100/0/',
  locale: 'en-US',
  email: 'doe@email.com',
  email_verified: true,
};

/** A minimal JPEG start; the fake does not decode images. */
export const FAKE_JPEG = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
]);

export interface RecordedRequest {
  method: string;
  url: URL;
  headers: Headers;
  /** Parsed JSON, the form fields, or the number of bytes. */
  body: unknown;
}

export interface FakePost {
  id: string;
  author: string;
  commentary: string;
  createdAt: number;
  deleted: boolean;
  body: Record<string, unknown>;
}

type Handler = (request: RecordedRequest) => Response | undefined;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The error body of the REST APIs: message, serviceErrorCode, status. */
const restError = (status: number, message: string, headers: Record<string, string> = {}): Response =>
  json({ message, serviceErrorCode: status === 401 ? 65601 : 100, status }, status, headers);

const listOf = (value: string | null): string[] => {
  const match = /^List\((.*)\)$/.exec(value ?? '');
  return match?.[1] ? match[1].split(',').map((entry) => decodeURIComponent(entry)) : [];
};

const parseBody = (init: RequestInit | undefined, headers: Headers): unknown => {
  const body = init?.body;
  if (body === undefined || body === null) {
    return undefined;
  }
  if (body instanceof Uint8Array) {
    return body.byteLength;
  }
  const text = typeof body === 'string' ? body : '';
  if ((headers.get('content-type') ?? '').includes('x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text));
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

export class FakeLinkedIn {
  readonly requests: RecordedRequest[] = [];
  readonly posts = new Map<string, FakePost>();
  readonly comments: { post: string; actor: string; text: string }[] = [];
  readonly uploads = new Map<string, number>();
  /** The statuses GET /rest/images returns one after the other; the last one repeats. */
  imageStatuses: string[] = ['AVAILABLE'];
  /** The scope of the token answer. */
  tokenScope = 'openid profile w_member_social';
  /** The host of the upload URLs. */
  uploadHost = 'www.linkedin.com';
  /** Leave the x-restli-id header out of the post answer. */
  omitPostId = false;
  /** The status of a comment call; 201 creates it. */
  commentStatus = 201;
  analytics: Record<string, number> = {
    IMPRESSION: 1520,
    MEMBERS_REACHED: 980,
    REACTION: 41,
    COMMENT: 7,
    RESHARE: 3,
  };
  followers = 321;
  organizationFollowers = 219145;
  organizationAcls: Record<string, unknown>[] = [
    {
      role: 'ADMINISTRATOR',
      organization: FAKE_ORGANIZATION_URN,
      roleAssignee: FAKE_PERSON_URN,
      state: 'APPROVED',
    },
  ];
  /** Answers that take precedence over the routes, for one-off failures. */
  readonly overrides: Handler[] = [];

  private nextId = 7_300_000_000_000_000_000n;
  private imageCalls = 0;

  readonly fetch: typeof fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    const request: RecordedRequest = {
      method: (init?.method ?? 'GET').toUpperCase(),
      url,
      headers,
      body: parseBody(init, headers),
    };
    this.requests.push(request);
    return Promise.resolve(this.answer(request));
  };

  /** The requests to LinkedIn itself, without the storage. */
  linkedInRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.url.hostname.endsWith('linkedin.com'));
  }

  /** Adds a post as if it had been created earlier. */
  seedPost(post: Omit<FakePost, 'deleted' | 'body'> & { deleted?: boolean }): void {
    this.posts.set(post.id, { deleted: false, body: {}, ...post });
  }

  private answer(request: RecordedRequest): Response {
    for (const override of this.overrides) {
      const response = override(request);
      if (response) {
        return response;
      }
    }
    const { url } = request;
    if (url.origin === new URL(FAKE_STORAGE_URL).origin) {
      return this.storage(request);
    }
    const failure = /^Bearer fail-(\d{3})(?:-(\d+))?$/.exec(request.headers.get('authorization') ?? '');
    if (failure?.[1]) {
      return restError(
        Number(failure[1]),
        'Fake failure',
        failure[2] === undefined ? {} : { 'retry-after': failure[2] },
      );
    }
    if (url.hostname === 'www.linkedin.com' && url.pathname === '/oauth/v2/accessToken') {
      return this.token(request);
    }
    if (url.hostname === this.uploadHost && url.pathname.startsWith('/dms-uploads/')) {
      return this.upload(request);
    }
    if (url.hostname !== 'api.linkedin.com') {
      return new Response('unknown host', { status: 404 });
    }
    if (url.pathname === '/v2/userinfo') {
      return request.headers.get('authorization')?.startsWith('Bearer ') === true
        ? json(USERINFO_FIXTURE)
        : restError(401, 'Empty oauth2_access_token');
    }
    if (!url.pathname.startsWith('/rest/')) {
      return restError(404, 'Not found');
    }
    if (!/^\d{6}$/.test(request.headers.get('linkedin-version') ?? '')) {
      return restError(400, 'A version header is required');
    }
    if (request.headers.get('x-restli-protocol-version') !== '2.0.0') {
      return restError(400, 'Rest.li protocol 2.0.0 is required');
    }
    if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
      return restError(401, 'Empty oauth2_access_token');
    }
    return this.rest(request);
  }

  private rest(request: RecordedRequest): Response {
    const { url, method } = request;
    const path = decodeURIComponent(url.pathname.slice('/rest'.length));
    const params = url.searchParams;
    if (method === 'POST' && path === '/images' && params.get('action') === 'initializeUpload') {
      return this.initializeUpload(request);
    }
    if (method === 'GET' && path.startsWith('/images/urn:li:image:')) {
      const status = this.imageStatuses[Math.min(this.imageCalls, this.imageStatuses.length - 1)];
      this.imageCalls += 1;
      return json({ id: path.slice('/images/'.length), status });
    }
    if (method === 'POST' && path === '/posts') {
      return this.createPost(request);
    }
    if (method === 'DELETE' && path.startsWith('/posts/')) {
      const post = this.posts.get(path.slice('/posts/'.length));
      if (request.headers.get('x-restli-method') !== 'DELETE') {
        return restError(400, 'X-RestLi-Method DELETE is required');
      }
      if (!post) {
        return restError(404, 'NOT_FOUND');
      }
      post.deleted = true;
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/posts' && params.get('q') === 'author') {
      return this.postsByAuthor(request);
    }
    if (method === 'GET' && path === '/posts' && params.has('ids')) {
      return this.batchGetPosts(request);
    }
    if (method === 'POST' && /^\/socialActions\/urn:li:(share|ugcPost):\d+\/comments$/.test(path)) {
      if (this.commentStatus !== 201) {
        return restError(this.commentStatus, 'ACCESS_DENIED');
      }
      const body = request.body as { actor: string; message: { text: string } };
      this.comments.push({ post: path.split('/')[2] ?? '', actor: body.actor, text: body.message.text });
      return json({ id: '6643206422739898368' }, 201, { 'x-restli-id': '6643206422739898368' });
    }
    if (method === 'GET' && path === '/memberCreatorPostAnalytics') {
      return this.memberAnalytics(request);
    }
    if (method === 'GET' && path === '/memberFollowersCount' && params.get('q') === 'me') {
      return json({
        elements: [{ memberFollowersCount: this.followers }],
        paging: { count: 10, start: 0, total: 1, links: [] },
      });
    }
    if (method === 'GET' && path === '/organizationAcls' && params.get('q') === 'roleAssignee') {
      return json({ elements: this.organizationAcls, paging: { count: 100, start: 0, links: [] } });
    }
    if (method === 'GET' && path === '/organizations' && params.has('ids')) {
      const results = Object.fromEntries(
        listOf(params.get('ids'))
          .filter((id) => `urn:li:organization:${id}` === FAKE_ORGANIZATION_URN)
          .map((id) => [id, { id: Number(id), vanityName: 'devtestcocompany', localizedName: 'Devtestco' }]),
      );
      return json({ results, statuses: {}, errors: {} });
    }
    if (method === 'GET' && path === '/organizationalEntityShareStatistics') {
      return this.shareStatistics(request);
    }
    if (method === 'GET' && path === `/networkSizes/${FAKE_ORGANIZATION_URN}`) {
      return params.get('edgeType') === 'COMPANY_FOLLOWED_BY_MEMBER'
        ? json({ firstDegreeSize: this.organizationFollowers })
        : restError(400, 'Invalid edgeType');
    }
    return restError(404, `No route for ${method} ${path}`);
  }

  private token(request: RecordedRequest): Response {
    const form = request.body as Record<string, string>;
    const invalid = (description: string) =>
      json({ error: 'invalid_request', error_description: description }, 400);
    if (form.client_id !== FAKE_CLIENT_ID || form.client_secret !== FAKE_CLIENT_SECRET) {
      return json({ error: 'invalid_client', error_description: 'Client authentication failed' }, 401);
    }
    if (form.grant_type === 'authorization_code') {
      if (form.code !== FAKE_CODE || form.redirect_uri !== FAKE_REDIRECT_URI) {
        return invalid('Unable to retrieve access token: authorization code not found');
      }
      return json({
        access_token: 'AQUvlL_DYEzvT2wz1QJiEPeLioeA',
        expires_in: 5184000,
        scope: this.tokenScope,
      });
    }
    if (form.grant_type === 'refresh_token') {
      if (form.refresh_token !== FAKE_REFRESH_TOKEN) {
        return invalid('The provided authorization grant or refresh token is invalid, expired or revoked');
      }
      return json({
        access_token: 'BBBB2kXITHELmWblJigbHEuoFdfRhOwGA0QNnumBI8XOVSs0HtOHE',
        expires_in: 5184000,
        refresh_token: FAKE_REFRESH_TOKEN,
        refresh_token_expires_in: 26265600,
        scope: this.tokenScope,
      });
    }
    return invalid('A required parameter "grant_type" is missing');
  }

  private storage(request: RecordedRequest): Response {
    if (request.url.pathname.endsWith('/expired.jpg')) {
      return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    }
    return new Response(FAKE_JPEG, {
      status: 200,
      headers: { 'content-type': 'image/jpeg', 'content-length': String(FAKE_JPEG.byteLength) },
    });
  }

  private initializeUpload(request: RecordedRequest): Response {
    const owner = (request.body as { initializeUploadRequest?: { owner?: string } }).initializeUploadRequest
      ?.owner;
    if (owner !== FAKE_PERSON_URN && owner !== FAKE_ORGANIZATION_URN) {
      return restError(
        403,
        'Accessing this image resource is forbidden. Please check your permissions for this resource',
      );
    }
    const id = `C4E10AQ${String(this.uploads.size + 1).padStart(5, '0')}`;
    this.uploads.set(`urn:li:image:${id}`, 0);
    return json({
      value: {
        uploadUrlExpiresAt: 1650567510704,
        uploadUrl: `https://${this.uploadHost}/dms-uploads/${id}/uploaded-image/0?ca=vector_ads&cn=uploads&sync=0&v=beta&ut=08zHQjMjAOLqc1`,
        image: `urn:li:image:${id}`,
      },
    });
  }

  private upload(request: RecordedRequest): Response {
    if (request.method !== 'PUT' || !request.headers.get('authorization')?.startsWith('Bearer ')) {
      return restError(401, 'Upload needs PUT with a token');
    }
    const id = request.url.pathname.split('/')[2] ?? '';
    const key = `urn:li:image:${id}`;
    if (!this.uploads.has(key)) {
      return restError(404, 'Unknown upload');
    }
    this.uploads.set(key, typeof request.body === 'number' ? request.body : 0);
    return new Response(null, { status: 201 });
  }

  private createPost(request: RecordedRequest): Response {
    const body = request.body as Record<string, unknown>;
    if (
      typeof body.commentary !== 'string' ||
      typeof body.author !== 'string' ||
      body.lifecycleState !== 'PUBLISHED'
    ) {
      return restError(400, 'MISSING_FIELD');
    }
    const content = body.content as
      { media?: { id: string }; multiImage?: { images: { id: string }[] } } | undefined;
    const imageIds = [
      ...(content?.media ? [content.media.id] : []),
      ...(content?.multiImage?.images.map((image) => image.id) ?? []),
    ];
    if (imageIds.some((id) => (this.uploads.get(id) ?? 0) === 0)) {
      return restError(400, 'INVALID_IMAGE_ID');
    }
    this.nextId += 1n;
    const id = `urn:li:${imageIds.length > 0 ? 'ugcPost' : 'share'}:${this.nextId.toString()}`;
    this.posts.set(id, {
      id,
      author: body.author,
      commentary: body.commentary,
      createdAt: Date.now(),
      deleted: false,
      body,
    });
    return new Response(null, { status: 201, headers: this.omitPostId ? {} : { 'x-restli-id': id } });
  }

  private postsByAuthor(request: RecordedRequest): Response {
    const author = request.url.searchParams.get('author');
    const count = Number(request.url.searchParams.get('count') ?? '10');
    const elements = [...this.posts.values()]
      .filter((post) => post.author === author && !post.deleted)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, count)
      .map((post) => ({
        lifecycleState: 'PUBLISHED',
        lastModifiedAt: post.createdAt,
        visibility: 'PUBLIC',
        publishedAt: post.createdAt,
        author: post.author,
        distribution: { feedDistribution: 'MAIN_FEED', thirdPartyDistributionChannels: [] },
        content: {},
        lifecycleStateInfo: { isEditedByAuthor: false },
        isReshareDisabledByAuthor: false,
        createdAt: post.createdAt,
        id: post.id,
        commentary: post.commentary,
      }));
    return json({ paging: { start: 0, count, links: [] }, elements });
  }

  private batchGetPosts(request: RecordedRequest): Response {
    if (request.headers.get('x-restli-method') !== 'BATCH_GET') {
      return restError(400, 'X-RestLi-Method BATCH_GET is required');
    }
    const results: Record<string, unknown> = {};
    const statuses: Record<string, number> = {};
    const errors: Record<string, unknown> = {};
    for (const id of listOf(request.url.searchParams.get('ids'))) {
      const post = this.posts.get(id);
      if (post && !post.deleted) {
        results[id] = { id, author: post.author, commentary: post.commentary, lifecycleState: 'PUBLISHED' };
        statuses[id] = 200;
      } else {
        statuses[id] = 404;
        errors[id] = { status: 404, message: 'NOT_FOUND' };
      }
    }
    return json({ results, statuses, errors });
  }

  private memberAnalytics(request: RecordedRequest): Response {
    const params = request.url.searchParams;
    const entity = /^\((share|ugc):(urn:li:(?:share|ugcPost):\d+)\)$/.exec(params.get('entity') ?? '');
    const queryType = params.get('queryType') ?? '';
    if (params.get('q') !== 'entity' || !entity?.[2] || !(queryType in this.analytics)) {
      return restError(400, 'Invalid analytics request');
    }
    const post = this.posts.get(entity[2]);
    if (!post || post.deleted) {
      return restError(404, 'NOT_FOUND');
    }
    return json({
      elements: [
        {
          count: this.analytics[queryType],
          metricType: queryType,
          targetEntity: { [entity[1] ?? 'share']: entity[2] },
        },
      ],
      paging: { count: 10, start: 0, links: [] },
    });
  }

  private shareStatistics(request: RecordedRequest): Response {
    const params = request.url.searchParams;
    if (
      params.get('q') !== 'organizationalEntity' ||
      params.get('organizationalEntity') !== FAKE_ORGANIZATION_URN
    ) {
      return restError(400, 'Invalid share statistics request');
    }
    const kind = params.has('shares') ? 'share' : 'ugcPost';
    const ids = listOf(params.get(params.has('shares') ? 'shares' : 'ugcPosts'));
    const elements = ids
      .filter((id) => this.posts.has(id))
      .map((id) => ({
        organizationalEntity: FAKE_ORGANIZATION_URN,
        [kind]: id,
        totalShareStatistics: {
          clickCount: 78,
          commentCount: 24,
          engagement: 0.022886324947985624,
          impressionCount: 5287,
          likeCount: 14,
          shareCount: 5,
        },
      }));
    return json({ elements, paging: { count: 10, links: [], start: 0 } });
  }
}
