import deAuth from '../../messages/de/auth.json';
import deCommon from '../../messages/de/common.json';
import deErrors from '../../messages/de/errors.json';
import enAuth from '../../messages/en/auth.json';
import enCommon from '../../messages/en/common.json';
import enErrors from '../../messages/en/errors.json';
import type { Locale } from './locale';

// One file per namespace and language (guide step 1.10). The keys of common.json are top-level
// namespaces themselves (app, nav, shell, ...); every other file is the namespace of its name.
const MESSAGES = {
  de: {
    ...deCommon,
    auth: deAuth,
    errors: deErrors,
  },
  en: {
    ...enCommon,
    auth: enAuth,
    errors: enErrors,
  },
} as const;

export type Messages = (typeof MESSAGES)['de'];

export const messagesFor = (locale: Locale): Messages => MESSAGES[locale];
