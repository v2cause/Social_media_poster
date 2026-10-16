import type { PlatformCapabilities } from './types';

// Instagram API with Instagram Login, content publishing (feed posts and carousels).
// Caption, hashtag, mention and carousel limits checked 2026-10-16:
// https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media/
export const instagram: PlatformCapabilities = {
  platform: 'INSTAGRAM',
  text: {
    counting: 'graphemes',
    // The caption takes at most 2,200 characters.
    maxLength: 2200,
    // The feed shows roughly 125 characters before "...more". Approximate hint for the preview,
    // not a limit.
    recommendedLength: 125,
  },
  // At most 30 hashtags and 20 @ tags per caption.
  hashtags: { max: 30 },
  mentions: { max: 20 },
  media: {
    // Feed posts always carry an image or a video.
    required: true,
    // A carousel holds up to 10 images and videos, also mixed.
    maxItems: 10,
    mixedKinds: true,
    kinds: {
      image: {
        maxItems: 10,
        // The API publishes JPEG only; the media pipeline renders JPEG for Instagram (phase 3).
        mimeTypes: ['image/jpeg'],
        // Between 4:5 and 1.91:1. Not confirmed on the official reference from this environment;
        // value of the architecture (media pipeline, guide phase 3). Re-check in phase 3.
        aspectRatio: { min: 4 / 5, max: 1.91 },
      },
      video: { maxItems: 10, mimeTypes: ['video/mp4', 'video/quicktime'] },
    },
  },
  firstComment: true,
};
