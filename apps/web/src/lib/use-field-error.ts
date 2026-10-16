'use client';

import { useTranslations } from 'next-intl';
import type { FieldError } from 'react-hook-form';

// Translates the zod issues of a form field. The schemas come from @smp/contracts and carry no
// texts; a custom message is a key under errors.validation.

const KNOWN = new Set([
  'required',
  'too_small',
  'too_big',
  'invalid_format',
  'email',
  'invalid_value',
  'invalid_timezone',
  'passwords_differ',
  'too_many_items',
  'item_too_long',
]);

export function useFieldError() {
  const t = useTranslations('errors.validation');
  return (
    error: FieldError | undefined,
    limits: { minimum?: number; maximum?: number; length?: number } = {},
  ): string | undefined => {
    if (!error) {
      return undefined;
    }
    const custom = error.message && KNOWN.has(error.message) ? error.message : undefined;
    const key =
      custom ?? (error.type === 'invalid_format' && error.message?.includes('email') ? 'email' : error.type);
    switch (key) {
      case 'too_small':
        return limits.minimum === undefined ? t('required') : t('too_small', { minimum: limits.minimum });
      case 'too_big':
        return t('too_big', { maximum: limits.maximum ?? 0 });
      case 'too_many_items':
        return t('too_many_items', { maximum: limits.maximum ?? 0 });
      case 'item_too_long':
        return t('item_too_long', { length: limits.length ?? 0 });
      case 'required':
      case 'invalid_format':
      case 'email':
      case 'invalid_value':
      case 'invalid_timezone':
      case 'passwords_differ':
        return t(key);
      default:
        return t('invalid');
    }
  };
}
