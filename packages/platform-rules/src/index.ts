// Platform capabilities, post validation and character counting for web and backend. Runs in the
// browser too, so it uses no Node APIs (guide step 2.2).

export { PLATFORMS, type Platform } from './platforms';
export { CAPABILITIES, capabilitiesOf } from './capabilities';
export type { MediaKind, MediaKindRules, PlatformCapabilities } from './capabilities/types';
export {
  composePostText,
  countGraphemes,
  countText,
  extractHashtags,
  extractMentions,
  xWeightedLength,
  type TextCount,
} from './count-text';
export {
  validatePost,
  VALIDATION_ISSUE_CODES,
  type MediaItem,
  type PostToValidate,
  type ValidationIssue,
  type ValidationIssueCode,
} from './validate-post';
