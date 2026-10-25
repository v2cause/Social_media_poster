import { failureFor, fakeFetch, formOf, imageFor, json } from '../live/fake-platform';

// A fake of the Graph API calls of the Facebook and Instagram adapters (test support, guide step
// 4.13): OAuth, pages, photos and feed posts, Instagram containers and publishing, insights.
// Answer forms after the Graph API docs as known from secondary sources (ADR 0046).

export const PAGE_ID = '1100200300';
export const IG_USER_ID = '17841400000000001';

const notFound = (): Response =>
  json({ error: { message: 'Unsupported get request', code: 100, error_subcode: 33 } }, 400);

export interface FakeMetaPost {
  id: string;
  message: string;
  photos: string[];
  createdAt: Date;
  deleted: boolean;
}

export class FakeMeta {
  readonly pagePosts: FakeMetaPost[] = [];
  readonly photos = new Map<string, { published: boolean; alt: string | null }>();
  readonly containers = new Map<string, { form: Record<string, string>; polls: number }>();
  readonly media: FakeMetaPost[] = [];
  readonly comments: { on: string; message: string }[] = [];
  /** How many polls a container stays IN_PROGRESS. */
  containerPolls = 0;
  quotaUsage = 3;
  /** Answers containers with an alt text like an API without that field. */
  refuseAltText = false;
  private next = 9_000_000;
  readonly client;

  constructor(private readonly version = 'v24.0') {
    this.client = fakeFetch((request, url) => this.handle(request, url));
  }

  get requests(): Request[] {
    return this.client.requests;
  }

  private id(): string {
    return String(this.next++);
  }

  private async handle(request: Request, url: URL): Promise<Response> {
    const image = imageFor(url);
    if (image) {
      return image;
    }
    if (url.host === 'api.instagram.com' && url.pathname === '/oauth/access_token') {
      return json({
        data: [
          {
            access_token: 'ig-short',
            user_id: IG_USER_ID,
            permissions: 'instagram_business_basic,instagram_business_content_publish',
          },
        ],
      });
    }
    if (url.host === 'graph.instagram.com' && url.pathname === '/access_token') {
      return json({ access_token: 'ig-long', token_type: 'bearer', expires_in: 5_183_944 });
    }
    if (url.host === 'graph.instagram.com' && url.pathname === '/refresh_access_token') {
      return json({ access_token: 'ig-refreshed', token_type: 'bearer', expires_in: 5_183_944 });
    }
    const failure = failureFor(request);
    if (failure) {
      return failure;
    }
    const prefix = `/${this.version}/`;
    if (!url.pathname.startsWith(prefix)) {
      return json({ error: { message: 'unknown version', code: 2635 } }, 400);
    }
    const path = url.pathname.slice(prefix.length);
    return url.host === 'graph.instagram.com'
      ? this.instagram(request, url, path)
      : this.facebook(request, url, path);
  }

  private async facebook(request: Request, url: URL, path: string): Promise<Response> {
    if (path === 'oauth/access_token') {
      return url.searchParams.get('grant_type') === 'fb_exchange_token'
        ? json({ access_token: 'user-long', token_type: 'bearer', expires_in: 5_183_944 })
        : json({ access_token: 'user-short', token_type: 'bearer', expires_in: 5_400 });
    }
    if (path === 'me') {
      return json({ id: '5550001', name: 'Mira Nordlicht' });
    }
    if (path === 'me/permissions') {
      if (request.method === 'DELETE') {
        return json({ success: true });
      }
      return json({
        data: [
          { permission: 'pages_show_list', status: 'granted' },
          { permission: 'pages_manage_posts', status: 'granted' },
          { permission: 'read_insights', status: 'declined' },
        ],
      });
    }
    if (path === 'me/accounts') {
      return json({
        data: [
          {
            id: PAGE_ID,
            name: 'Nordlicht Haustechnik',
            access_token: 'page-token',
            tasks: ['CREATE_CONTENT', 'MODERATE'],
          },
          { id: '1100200399', name: 'Nur Analyse', access_token: 'page-token-2', tasks: ['ANALYZE'] },
        ],
      });
    }
    if (path === `${PAGE_ID}/photos` && request.method === 'POST') {
      const form = await formOf(request);
      const photo = this.id();
      const published = form.published !== 'false';
      this.photos.set(photo, { published, alt: form.alt_text_custom ?? null });
      if (!published) {
        return json({ id: photo });
      }
      const post = this.addPagePost(form.message ?? '', [photo]);
      return json({ id: photo, post_id: post.id });
    }
    if (path === `${PAGE_ID}/feed` && request.method === 'POST') {
      const form = await formOf(request);
      if (
        this.pagePosts.some(
          (post) => post.message === form.message && !post.deleted && post.message.length > 0,
        )
      ) {
        return json({ error: { message: 'Duplicate status message', code: 506 } }, 400);
      }
      const photos = Object.entries(form)
        .filter(([name]) => name.startsWith('attached_media['))
        .map(([, value]) => (JSON.parse(value) as { media_fbid: string }).media_fbid);
      return json({ id: this.addPagePost(form.message ?? '', photos).id });
    }
    if (path === `${PAGE_ID}/posts`) {
      return json({
        data: this.pagePosts
          .filter((post) => !post.deleted)
          .reverse()
          .map((post) => ({
            id: post.id,
            message: post.message,
            created_time: post.createdAt.toISOString().replace('Z', '+0000'),
          })),
      });
    }
    if (path === PAGE_ID) {
      return json({ followers_count: 812, fan_count: 790, id: PAGE_ID });
    }
    const [objectId, edge] = path.split('/');
    const post = this.pagePosts.find((entry) => entry.id === objectId);
    if (!post || post.deleted) {
      return notFound();
    }
    if (request.method === 'DELETE') {
      post.deleted = true;
      return json({ success: true });
    }
    if (edge === 'comments') {
      this.comments.push({ on: post.id, message: (await formOf(request)).message ?? '' });
      return json({ id: this.id() });
    }
    if (edge === 'insights') {
      return json({
        data: [
          { name: 'post_media_view', period: 'lifetime', values: [{ value: 410 }] },
          { name: 'post_impressions_unique', period: 'lifetime', values: [{ value: 300 }] },
          { name: 'post_clicks', period: 'lifetime', values: [{ value: 12 }] },
        ],
      });
    }
    return json({
      id: post.id,
      reactions: { data: [], summary: { total_count: 21 } },
      comments: { data: [], summary: { total_count: 3 } },
    });
  }

  private async instagram(request: Request, url: URL, path: string): Promise<Response> {
    if (path === 'me') {
      return json({
        id: '990001',
        user_id: IG_USER_ID,
        username: 'nordlicht.haustechnik',
        name: 'Nordlicht Haustechnik',
      });
    }
    if (path === `${IG_USER_ID}/content_publishing_limit`) {
      return json({
        data: [{ quota_usage: this.quotaUsage, config: { quota_total: 100, quota_duration: 86400 } }],
      });
    }
    if (path === `${IG_USER_ID}/media` && request.method === 'POST') {
      const form = await formOf(request);
      if (this.refuseAltText && form.alt_text !== undefined) {
        return json({ error: { message: '(#100) Param alt_text is not valid', code: 100 } }, 400);
      }
      if (!form.image_url && form.media_type !== 'CAROUSEL') {
        return json({ error: { message: 'image_url missing', code: 100 } }, 400);
      }
      const id = this.id();
      this.containers.set(id, { form, polls: 0 });
      return json({ id });
    }
    if (path === `${IG_USER_ID}/media_publish`) {
      const container = this.containers.get((await formOf(request)).creation_id ?? '');
      if (!container) {
        return json({ error: { message: 'unknown container', code: 100 } }, 400);
      }
      const media = {
        id: this.id(),
        message: container.form.caption ?? '',
        photos: [],
        createdAt: new Date(),
        deleted: false,
      };
      this.media.push(media);
      return json({ id: media.id });
    }
    if (path === `${IG_USER_ID}/media`) {
      return json({
        data: this.media
          .filter((entry) => !entry.deleted)
          .reverse()
          .map((entry) => ({
            id: entry.id,
            caption: entry.message,
            timestamp: entry.createdAt.toISOString().replace('Z', '+0000'),
            permalink: `https://www.instagram.com/p/${entry.id}/`,
          })),
      });
    }
    if (path === IG_USER_ID) {
      return json({ followers_count: 1520, id: IG_USER_ID });
    }
    const [objectId, edge] = path.split('/');
    const container = this.containers.get(objectId ?? '');
    if (container && url.searchParams.get('fields')?.includes('status_code')) {
      container.polls += 1;
      return json({
        status_code: container.polls > this.containerPolls ? 'FINISHED' : 'IN_PROGRESS',
        id: objectId,
      });
    }
    const media = this.media.find((entry) => entry.id === objectId);
    if (!media || media.deleted) {
      return notFound();
    }
    if (edge === 'comments') {
      this.comments.push({ on: media.id, message: (await formOf(request)).message ?? '' });
      return json({ id: this.id() });
    }
    if (edge === 'insights') {
      return json({
        data: ['views', 'reach', 'likes', 'comments', 'shares', 'saved'].map((name, index) => ({
          name,
          period: 'lifetime',
          values: [{ value: (index + 1) * 10 }],
        })),
      });
    }
    if (url.searchParams.get('fields') === 'permalink') {
      return json({ permalink: `https://www.instagram.com/p/${media.id}/`, id: media.id });
    }
    return json({ like_count: 18, comments_count: 2, id: media.id });
  }

  private addPagePost(message: string, photos: string[]): FakeMetaPost {
    const post = { id: `${PAGE_ID}_${this.id()}`, message, photos, createdAt: new Date(), deleted: false };
    this.pagePosts.push(post);
    return post;
  }
}
