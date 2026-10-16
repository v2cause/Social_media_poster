import { capabilitiesOf } from './capabilities';
import type { MediaKind } from './capabilities/types';
import { composePostText, countText, extractHashtags, extractMentions } from './count-text';
import type { Platform } from './platforms';
import { ASPECT_RATIO_TOLERANCE, ratioFits } from './renditions';

// validatePost() checks a variant against the rules of its platform (guide step 2.2). The UI
// translates the codes (errors.validation.<CODE>); the server rejects or flags the same issues.

export const VALIDATION_ISSUE_CODES = [
  'TEXT_TOO_LONG',
  'MEDIA_REQUIRED',
  'TOO_MANY_MEDIA',
  'ASPECT_RATIO_OUT_OF_RANGE',
  'MIXED_ASPECT_RATIOS',
  'TOO_MANY_HASHTAGS',
  'TOO_MANY_MENTIONS',
  'UNSUPPORTED_MEDIA_TYPE',
  'MIXED_MEDIA_NOT_SUPPORTED',
  'FIRST_COMMENT_NOT_SUPPORTED',
] as const;
export type ValidationIssueCode = (typeof VALIDATION_ISSUE_CODES)[number];

export interface ValidationIssue {
  code: ValidationIssueCode;
  /** The platform limit, where one applies. */
  limit?: number;
  /** The measured value, where one applies. */
  actual?: number;
  /** The media item the issue is about. */
  mediaIndex?: number;
}

export interface MediaItem {
  kind: MediaKind;
  mimeType: string;
  width?: number;
  height?: number;
}

export interface PostToValidate {
  platform: Platform;
  text: string;
  hashtags?: readonly string[];
  firstComment?: string | null;
  media?: readonly MediaItem[];
}

export function validatePost(post: PostToValidate): ValidationIssue[] {
  const capabilities = capabilitiesOf(post.platform);
  const issues: ValidationIssue[] = [];
  const text = composePostText(post.text, post.hashtags);

  const count = countText(post.platform, text);
  if (count.overLimit) {
    issues.push({ code: 'TEXT_TOO_LONG', limit: count.max, actual: count.length });
  }
  const hashtagLimit = capabilities.hashtags.max;
  const hashtags = extractHashtags(text).length;
  if (hashtagLimit !== undefined && hashtags > hashtagLimit) {
    issues.push({ code: 'TOO_MANY_HASHTAGS', limit: hashtagLimit, actual: hashtags });
  }
  const mentionLimit = capabilities.mentions.max;
  const mentions = extractMentions(text).length;
  if (mentionLimit !== undefined && mentions > mentionLimit) {
    issues.push({ code: 'TOO_MANY_MENTIONS', limit: mentionLimit, actual: mentions });
  }
  if (!capabilities.firstComment && (post.firstComment ?? '').trim().length > 0) {
    issues.push({ code: 'FIRST_COMMENT_NOT_SUPPORTED' });
  }

  const media = post.media ?? [];
  const rules = capabilities.media;
  if (rules.required && media.length === 0) {
    issues.push({ code: 'MEDIA_REQUIRED' });
  }
  media.forEach((item, mediaIndex) => {
    const kind = rules.kinds[item.kind];
    if (!kind?.mimeTypes.includes(item.mimeType.toLowerCase())) {
      issues.push({ code: 'UNSUPPORTED_MEDIA_TYPE', mediaIndex });
      return;
    }
    if (
      kind.aspectRatio &&
      item.width &&
      item.height &&
      !ratioFits(item.width / item.height, kind.aspectRatio)
    ) {
      issues.push({ code: 'ASPECT_RATIO_OUT_OF_RANGE', mediaIndex });
    }
  });
  if (rules.uniformAspectRatio) {
    const ratios = media.flatMap((item) => (item.width && item.height ? [item.width / item.height] : []));
    const first = ratios[0];
    if (first !== undefined && ratios.some((ratio) => Math.abs(ratio - first) > ASPECT_RATIO_TOLERANCE)) {
      issues.push({ code: 'MIXED_ASPECT_RATIOS' });
    }
  }

  const kinds = new Set(media.map((item) => item.kind));
  if (!rules.mixedKinds && kinds.size > 1) {
    issues.push({ code: 'MIXED_MEDIA_NOT_SUPPORTED' });
  }
  const counts = [...kinds].map((kind) => ({
    limit: rules.kinds[kind]?.maxItems,
    actual: media.filter((item) => item.kind === kind).length,
  }));
  counts.push({ limit: rules.maxItems, actual: media.length });
  for (const { limit, actual } of counts) {
    if (limit !== undefined && actual > limit) {
      issues.push({ code: 'TOO_MANY_MEDIA', limit, actual });
      break;
    }
  }
  return issues;
}
