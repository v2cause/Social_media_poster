import type { Platform } from '../platforms';

export type MediaKind = 'image' | 'video' | 'gif';

export interface MediaKindRules {
  /** Most items of this kind in one post; undefined means not limited by these rules. */
  maxItems?: number;
  mimeTypes: readonly string[];
  /** Allowed width/height ratio; checked when the media item has dimensions. */
  aspectRatio?: { min: number; max: number };
}

export interface PlatformCapabilities {
  platform: Platform;
  text: {
    /** graphemes: Intl.Segmenter; x-weighted: twitter-text parseTweet().weightedLength. */
    counting: 'graphemes' | 'x-weighted';
    maxLength: number;
    /** Beyond this length the feed folds the text; a hint for the UI, not an error. */
    recommendedLength?: number;
  };
  hashtags: { max?: number };
  mentions: { max?: number };
  media: {
    required: boolean;
    /** Most items in one post across all kinds; undefined means not limited by these rules. */
    maxItems?: number;
    /** Whether one post may combine kinds, for example images and a video. */
    mixedKinds: boolean;
    /** Whether all items of one post must share their aspect ratio, as in Instagram carousels. */
    uniformAspectRatio?: boolean;
    kinds: Partial<Record<MediaKind, MediaKindRules>>;
  };
  /** Whether a first comment can be published with the post. */
  firstComment: boolean;
}
