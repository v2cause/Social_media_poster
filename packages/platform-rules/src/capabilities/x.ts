import type { PlatformCapabilities } from './types';

// X API v2 posts. Longer posts through X Premium are not supported in the MVP.
export const x: PlatformCapabilities = {
  platform: 'X',
  text: {
    // 280 weighted characters counted by twitter-text: most characters weigh 1, CJK and other
    // ranges 2, every emoji 2, every URL 23 (t.co), on NFC-normalized text. Checked 2026-10-16:
    // https://docs.x.com/fundamentals/counting-characters
    counting: 'x-weighted',
    maxLength: 280,
  },
  hashtags: {},
  mentions: {},
  media: {
    required: false,
    // Up to 4 images, or 1 GIF, or 1 video per post. Not confirmed from this environment
    // (media upload docs: https://docs.x.com/x-api/media/introduction); re-check in phase 4.
    maxItems: 4,
    mixedKinds: false,
    kinds: {
      image: { maxItems: 4, mimeTypes: ['image/jpeg', 'image/png', 'image/webp'] },
      gif: { maxItems: 1, mimeTypes: ['image/gif'] },
      video: { maxItems: 1, mimeTypes: ['video/mp4'] },
    },
  },
  // A first comment would be a reply post; not part of the MVP.
  firstComment: false,
};
