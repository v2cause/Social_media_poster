// The paid operations of the X API and the keys they are recorded under (guide step 4.14,
// PriceBook keys in src/prices.ts). Checked 2026-11-25 against
// https://docs.x.com/x-api/getting-started/pricing ("Credit consumption details") and the
// changelog entry of 2026-04-16 (https://docs.x.com/changelog, "Owned Reads now $0.001"):
// - Post: Create $0.015 per request, Post: Create (with URL) $0.200 per request;
// - Posts: Read $0.005 per post returned; Owned Reads $0.001 per post for GET /2/users/{id}/tweets
//   when {id} is the authenticated user and that user owns the developer app;
// - User: Read $0.010 per user returned;
// - Media Metadata $0.005 per request.
// Media upload has no line of its own on the pricing page, so no cost is recorded for it. The page
// does not say which line DELETE /2/tweets/:id falls under ("Interaction: Delete" $0.010 or
// "Content: Manage" $0.005); it is recorded under a key of its own until the console settles it.
// Failed requests are not billed (https://docs.x.com/x-api/fundamentals/post-cap, FAQ "Do failed
// requests count?"), so costs are recorded only after a successful answer. X deduplicates a
// resource read twice within a UTC day; the records do not, so they can be slightly higher than
// the bill.

export const X_COST_OPERATIONS = {
  postCreate: 'x.post_create',
  postCreateWithUrl: 'x.post_create_with_url',
  postRead: 'x.post_read',
  ownedPostRead: 'x.owned_post_read',
  userRead: 'x.user_read',
  mediaMetadata: 'x.media_metadata',
  postDelete: 'x.post_delete',
} as const;

// URLs the way X links them in a post: with a scheme, starting with www., or a bare domain with a
// top-level domain of letters ("example.com/path"). The docs do not say how the URL surcharge is
// detected; this errs on the side of the higher price.
const URL_PATTERN =
  /(?:^|[\s(])(?:https?:\/\/\S+|www\.[^\s.]+\.\S+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,24}(?:\/\S*)?(?=$|[\s),.!?:;]))/iu;

/** Whether X will see a URL in the text, which makes the post cost $0.200 instead of $0.015. */
export const containsUrl = (text: string): boolean => URL_PATTERN.test(text);

/** The cost key of a post create for the text as it goes out. */
export const postCreateOperation = (text: string): string =>
  containsUrl(text) ? X_COST_OPERATIONS.postCreateWithUrl : X_COST_OPERATIONS.postCreate;
