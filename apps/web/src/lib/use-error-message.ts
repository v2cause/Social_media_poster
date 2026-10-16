'use client';

import { useTranslations } from 'next-intl';

import { errorCodeOf } from './errors';

/** The translated message of an API error (errors.codes.<code>), or a general one. */
export function useErrorMessage() {
  const t = useTranslations('errors');
  return (error: unknown): string => {
    const code = errorCodeOf(error);
    return code === 'unknown' ? t('unknown') : t(`codes.${code}`);
  };
}
