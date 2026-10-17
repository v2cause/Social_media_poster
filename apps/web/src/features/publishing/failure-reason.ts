import { useTranslations } from 'next-intl';

// The text of the failure code of a variant (guide steps 4.9 and 4.11), in the bell and in the
// post list. Codes without a text of their own read as "other".

const REASONS = [
  'PERMISSION_DENIED',
  'VALIDATION_REJECTED',
  'DUPLICATE',
  'TRANSIENT',
  'MEDIA_PROCESSING',
  'RATE_LIMITED',
  'OUTCOME_UNKNOWN',
  'CHALLENGE_REQUIRED',
  'SELECTOR_DRIFT',
  'REAUTH_REQUIRED',
  'SPEND_CAP',
  'MISSED_WINDOW',
  'SOCIAL_ACCOUNT_DISCONNECTED',
  'ADAPTER_UNAVAILABLE',
  'VARIANT_NOT_PUBLISHABLE',
  'INTERNAL',
] as const;
type Reason = (typeof REASONS)[number];
const isReason = (code: string): code is Reason => (REASONS as readonly string[]).includes(code);

export function useFailureReason(): (code: string) => string {
  const t = useTranslations('notifications.failureReasons');
  return (code) => (isReason(code) ? t(code) : t('other'));
}
