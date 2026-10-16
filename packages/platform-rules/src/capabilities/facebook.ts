import type { PlatformCapabilities } from './types';

// Facebook Pages, posts to the page feed.
export const facebook: PlatformCapabilities = {
  platform: 'FACEBOOK',
  text: {
    counting: 'graphemes',
    // 63,206 characters. Not confirmed: only secondary sources name the value, the Graph API
    // reference was not reachable from this environment. Checked 2026-10-16:
    // https://developers.facebook.com/docs/graph-api/reference/page/feed/
    maxLength: 63206,
    // Desktop feeds fold a post after about 477 characters, mobile ones earlier. The UI
    // recommends short texts; hint only.
    recommendedLength: 477,
  },
  hashtags: {},
  mentions: {},
  media: {
    required: false,
    mixedKinds: false,
    kinds: {
      // Several photos per post (attached_media); the upper bound is checked by the adapter in
      // phase 4, so these rules set none.
      image: { mimeTypes: ['image/jpeg', 'image/png', 'image/gif'] },
      video: { maxItems: 1, mimeTypes: ['video/mp4', 'video/quicktime'] },
    },
  },
  firstComment: true,
};
