import type { PlatformCapabilities } from './types';

// LinkedIn Posts API (person and organization posts).
export const linkedin: PlatformCapabilities = {
  platform: 'LINKEDIN',
  text: {
    counting: 'graphemes',
    // 3,000 characters of commentary. Not confirmed: the Posts API reference names no numeric
    // maximum (an overlong field fails with FIELD_LENGTH_TOO_LONG); the value is the documented
    // limit of the LinkedIn editor. Checked 2026-10-16:
    // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
    maxLength: 3000,
    // The feed folds a post after roughly 210 characters behind "...more". Approximate hint for
    // the preview, not a limit.
    recommendedLength: 210,
  },
  hashtags: {},
  mentions: {},
  media: {
    required: false,
    mixedKinds: false,
    kinds: {
      // A multi-image post has 2 to 20 images in JPG, GIF or PNG. Checked 2026-10-16:
      // https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api
      image: { maxItems: 20, mimeTypes: ['image/jpeg', 'image/png', 'image/gif'] },
      // One video per post (Videos API). Re-check against the API in phase 4.
      video: { maxItems: 1, mimeTypes: ['video/mp4'] },
    },
  },
  firstComment: true,
};
