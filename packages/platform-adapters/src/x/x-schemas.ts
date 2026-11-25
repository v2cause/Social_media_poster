import { z } from 'zod';

// The answers of X the adapter reads, checked with zod before use. The shapes follow the OpenAPI
// document (https://docs.x.com/openapi.json, version 2.175, checked 2026-11-25) and the prose
// pages named next to them. Unknown fields pass; only what the adapter uses is required.

const id = z.string().regex(/^[0-9]{1,19}$/);
const count = z.number().int().nonnegative();

/**
 * POST /2/oauth2/token. Example answer: {token_type, expires_in: 7200, access_token,
 * refresh_token, scope}; refresh_token only with offline.access. Checked 2026-11-25:
 * https://docs.x.com/fundamentals/authentication/oauth-2-0/oauth-1-0a-token-exchange ("Success
 * response") and https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code.
 */
export const tokenResponseSchema = z.looseObject({
  token_type: z.string().optional(),
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().optional(),
});
export type XTokenResponse = z.infer<typeof tokenResponseSchema>;

/** GET /2/users/me with user.fields=public_metrics,profile_image_url,username,name. */
export const usersMeSchema = z.looseObject({
  data: z.looseObject({
    id,
    name: z.string(),
    username: z.string(),
    profile_image_url: z.string().optional(),
    // UserPublicMetrics in the OpenAPI document requires followers_count, following_count,
    // post_count and listed_count; older prose pages still call post_count tweet_count.
    public_metrics: z
      .looseObject({
        followers_count: count.optional(),
        following_count: count.optional(),
        post_count: count.optional(),
        tweet_count: count.optional(),
        listed_count: count.optional(),
      })
      .optional(),
  }),
});
export type XUsersMe = z.infer<typeof usersMeSchema>;

/** POST /2/tweets answers 201 with data {id, text, edit_history_post_ids}. */
export const createPostSchema = z.looseObject({
  data: z.looseObject({ id, text: z.string().optional() }),
});

/** DELETE /2/tweets/:id answers data {deleted}. */
export const deletePostSchema = z.looseObject({
  data: z.looseObject({ deleted: z.boolean() }),
});

/**
 * A post as GET /2/users/:id/tweets and GET /2/tweets return it. PostPublicMetrics in the OpenAPI
 * document names repost_count; the metrics page still shows retweet_count
 * (https://docs.x.com/x-api/fundamentals/metrics, checked 2026-11-25). Both are accepted.
 */
export const postPublicMetricsSchema = z.looseObject({
  impression_count: count.optional(),
  like_count: count.optional(),
  reply_count: count.optional(),
  repost_count: count.optional(),
  retweet_count: count.optional(),
  quote_count: count.optional(),
  bookmark_count: count.optional(),
});
export type XPostPublicMetrics = z.infer<typeof postPublicMetricsSchema>;

const postSchema = z.looseObject({
  id,
  text: z.string().optional(),
  created_at: z.iso.datetime({ offset: true }).optional(),
  public_metrics: postPublicMetricsSchema.optional(),
});
export type XPost = z.infer<typeof postSchema>;

/** A partial error of a 200 answer, for example a post that no longer exists. */
const partialErrorSchema = z.looseObject({
  type: z.string().optional(),
  resource_id: z.string().optional(),
  resource_type: z.string().optional(),
  value: z.string().optional(),
});

/** GET /2/users/:id/tweets: data is left out when the account has no posts. */
export const userPostsSchema = z.looseObject({
  data: z.array(postSchema).optional(),
  meta: z.looseObject({ result_count: z.number().int().optional() }).optional(),
});

/** GET /2/tweets?ids=: found posts in data, missing ones in errors (resource-not-found). */
export const postsLookupSchema = z.looseObject({
  data: z.array(postSchema).optional(),
  errors: z.array(partialErrorSchema).optional(),
});

/** processing_info of an upload: state pending, in_progress, failed or succeeded. */
const processingInfoSchema = z.looseObject({
  state: z.string(),
  check_after_secs: z.number().int().nonnegative().optional(),
  progress_percent: z.number().optional(),
});

/** POST /2/media/upload/initialize answers data {id, media_key, expires_after_secs}. */
export const mediaInitializeSchema = z.looseObject({
  data: z.looseObject({ id, media_key: z.string().optional() }),
});

/** POST /2/media/upload/:id/finalize and GET /2/media/upload answer data {id, processing_info?}. */
export const mediaStatusSchema = z.looseObject({
  data: z.looseObject({
    id,
    media_key: z.string().optional(),
    processing_info: processingInfoSchema.optional(),
  }),
});
export type XMediaStatus = z.infer<typeof mediaStatusSchema>;

/** POST /2/media/metadata answers data {id, associated_metadata}. */
export const mediaMetadataSchema = z.looseObject({
  data: z.looseObject({ id: z.string() }),
});
