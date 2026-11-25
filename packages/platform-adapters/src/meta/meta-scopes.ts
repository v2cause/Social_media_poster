// The permissions the Meta connectors ask for. Both use Facebook Login (for Business) of the same
// Meta app, so the user grants one app; the Instagram connector uses the Instagram API with
// Facebook Login (see instagram-adapter.ts for why).

/**
 * Facebook Pages:
 * - pages_show_list: GET /me/accounts lists the Pages and their Page tokens;
 * - pages_manage_posts, pages_read_engagement: POST /{page}/feed and /{page}/photos ("A Page
 *   access token ... The pages_manage_posts permission, The pages_read_engagement permission, The
 *   pages_show_list permission"), and DELETE /{post};
 * - pages_read_user_content: GET /{page}/feed for the reconcile ("The pages_read_engagement
 *   permission, The pages_read_user_content permission");
 * - read_insights: GET /{post}/insights and /{page}/insights.
 * Checked 2026-11-25: https://developers.facebook.com/docs/graph-api/reference/page/feed/,
 * https://developers.facebook.com/docs/graph-api/reference/page/photos/,
 * https://developers.facebook.com/documentation/pages-api/posts,
 * https://developers.facebook.com/docs/graph-api/reference/v27.0/insights
 * A Page reached through a role in a business portfolio may need business_management to show up
 * in /me/accounts; the docs do not settle this, so it is left out (see FacebookConnectorOptions).
 */
export const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_manage_posts',
  'pages_read_engagement',
  'pages_read_user_content',
  'read_insights',
] as const;

/**
 * Instagram API with Facebook Login:
 * - instagram_basic, instagram_content_publish, pages_read_engagement: containers, media_publish,
 *   content_publishing_limit;
 * - instagram_manage_insights: GET /{media}/insights and /{ig-user}/insights;
 * - instagram_manage_contents: DELETE /{ig-media} (Facebook Login only);
 * - pages_show_list: GET /me/accounts to find the Page linked to the Instagram account.
 * If the Page role comes from a business portfolio, Meta also wants ads_management or ads_read;
 * left out here, a single person usually holds the Page directly.
 * Checked 2026-11-25:
 * https://developers.facebook.com/documentation/instagram-platform/content-publishing,
 * https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media,
 * https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media/insights,
 * https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/get-started
 */
export const INSTAGRAM_SCOPES = [
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
  'instagram_manage_contents',
  'pages_show_list',
  'pages_read_engagement',
] as const;
