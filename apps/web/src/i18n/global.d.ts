import type { Locale } from './locale';
import type { Messages } from './messages';

// Typed keys: a missing or misspelled message key fails the typecheck.
declare module 'next-intl' {
  interface AppConfig {
    Locale: Locale;
    Messages: Messages;
  }
}
