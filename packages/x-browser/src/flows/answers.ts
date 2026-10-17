import { z } from 'zod';

import type { XPostCounts, XUser } from '../protocol';

// The parts of the JSON answers of the web app the flows read (architecture 4.3). X nests its
// results deeply and moves the nesting more often than the objects themselves, so the flows look
// for an object by its fields instead of following a fixed path. Every object is checked with
// zod; one that no longer fits is a drift, never a guess.

const count = z.number().int().nonnegative();

const postSchema = z.object({
  rest_id: z.string().regex(/^\d{1,20}$/),
  legacy: z.object({
    created_at: z.string(),
    full_text: z.string().optional(),
    favorite_count: count.optional(),
    reply_count: count.optional(),
    retweet_count: count.optional(),
    quote_count: count.optional(),
    bookmark_count: count.optional(),
  }),
  views: z.object({ count: z.string().regex(/^\d+$/).optional() }).optional(),
});
export type XPost = z.infer<typeof postSchema>;

const userSchema = z.object({
  rest_id: z.string().regex(/^\d{1,20}$/),
  legacy: z.object({
    screen_name: z.string().regex(/^\w{1,15}$/),
    name: z.string(),
    followers_count: count.optional(),
    profile_image_url_https: z.url().optional(),
  }),
});

const errorsSchema = z.object({
  errors: z.array(z.object({ code: z.number().int(), message: z.string() })).min(1),
});

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

/** Every object inside a JSON value that matches, depth first, at most 40 levels deep. */
function collect(value: unknown, match: (node: Json) => boolean, found: Json[] = [], depth = 0): Json[] {
  if (depth > 40 || !isObject(value)) {
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, match, found, depth + 1);
    }
    return found;
  }
  if (match(value)) {
    found.push(value);
  }
  for (const child of Object.values(value)) {
    collect(child, match, found, depth + 1);
  }
  return found;
}

/** A post can come wrapped, for example as TweetWithVisibilityResults with the post in "tweet". */
const unwrap = (node: Json): Json => (isObject(node['tweet']) ? node['tweet'] : node);

const looksLikePost = (node: Json): boolean => {
  const legacy = unwrap(node)['legacy'];
  return typeof unwrap(node)['rest_id'] === 'string' && isObject(legacy) && 'created_at' in legacy;
};

/** Every post of an answer, for example the timeline of a profile, each once. */
export function postsIn(answer: unknown): XPost[] {
  const posts = new Map<string, XPost>();
  for (const node of collect(answer, looksLikePost)) {
    const parsed = postSchema.safeParse(unwrap(node));
    if (parsed.success && !posts.has(parsed.data.rest_id)) {
      posts.set(parsed.data.rest_id, parsed.data);
    }
  }
  return [...posts.values()];
}

/** The post with this id in an answer, or null. */
export const postIn = (answer: unknown, postId: string): XPost | null =>
  postsIn(answer).find((post) => post.rest_id === postId) ?? null;

/** The errors X sends next to or instead of the data. */
export const errorsOf = (answer: unknown): { code: number; message: string }[] => {
  const parsed = errorsSchema.safeParse(answer);
  return parsed.success ? parsed.data.errors : [];
};

/** True when the answer says the post is gone: a tombstone, or no post with that id (144). */
export function isGone(answer: unknown): boolean {
  if (collect(answer, (node) => node['__typename'] === 'TweetTombstone').length > 0) {
    return true;
  }
  return errorsOf(answer).some((error) => error.code === 144);
}

/** When X created the post; null when the date does not parse. */
export function createdAtOf(post: XPost): Date | null {
  const at = new Date(post.legacy.created_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function countsOf(post: XPost): XPostCounts {
  const views = post.views?.count;
  return {
    views: views === undefined ? null : Number(views),
    likes: post.legacy.favorite_count ?? null,
    replies: post.legacy.reply_count ?? null,
    reposts: post.legacy.retweet_count ?? null,
    quotes: post.legacy.quote_count ?? null,
    bookmarks: post.legacy.bookmark_count ?? null,
  };
}

const looksLikeUser = (node: Json): boolean => {
  const legacy = node['legacy'];
  return typeof node['rest_id'] === 'string' && isObject(legacy) && 'screen_name' in legacy;
};

/** A user of an answer by id or handle (the first without either), with the followers when sent. */
export function userIn(
  answer: unknown,
  by: { id?: string; handle?: string } = {},
): (XUser & { followers: number | null }) | null {
  for (const node of collect(answer, looksLikeUser)) {
    const parsed = userSchema.safeParse(node);
    if (!parsed.success) {
      continue;
    }
    const { rest_id: id, legacy } = parsed.data;
    const matches =
      (by.id === undefined || by.id === id) &&
      (by.handle === undefined || by.handle.toLowerCase() === legacy.screen_name.toLowerCase());
    if (matches) {
      return {
        id,
        handle: legacy.screen_name,
        name: legacy.name.slice(0, 100),
        avatarUrl: legacy.profile_image_url_https ?? null,
        followers: legacy.followers_count ?? null,
      };
    }
  }
  return null;
}

/** The step an answer of the login asks for next (onboarding/task.json), or null. */
export function subtaskOf(answer: unknown): string | null {
  const parsed = z
    .object({ subtasks: z.array(z.object({ subtask_id: z.string() })).min(1) })
    .safeParse(answer);
  return parsed.success ? (parsed.data.subtasks[0]?.subtask_id ?? null) : null;
}

/** Compares post texts the way X shows them: links shortened, whitespace and case loose. */
export const sameText = (shown: string, sent: string): boolean => {
  const normal = (text: string): string =>
    text
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  return normal(shown) === normal(sent);
};
