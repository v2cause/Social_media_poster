import type { Locale } from './locale';
import de from './legal/x-browser-risk.de.md';
import en from './legal/x-browser-risk.en.md';

// The risk text of the X browser (guide step 6.1, architecture 4.3), versioned and with the
// SHA-256 of each language. An acknowledgement stores the version and the hash of the text the
// user read. A changed text needs a new version: every workspace then has to acknowledge again.
// legal.test.ts compares the hashes with the files, so a text cannot change unnoticed.

export interface LegalText {
  version: string;
  texts: Readonly<Record<Locale, string>>;
  /** SHA-256 of each text in hex. */
  hashes: Readonly<Record<Locale, string>>;
}

/** The version of a legal text and the hash per language, as the use cases of the acknowledgement read them. */
export const riskTextOf = (text: LegalText): { version: string; hashOf(locale: string): string | null } => ({
  version: text.version,
  hashOf: (locale) => (locale === 'de' || locale === 'en' ? text.hashes[locale] : null),
});

export const X_BROWSER_RISK: LegalText = {
  version: '2026-10-17',
  texts: { de, en },
  hashes: {
    de: '2b916ec97fe61c44c6af2df2160982942b41bc85cbcb3bd477698d0c4c54ee70',
    en: 'fc5d6fd3f1dc7aa7b20028bc487f14547972fc07a6e7b374256841ee4e73b19d',
  },
};
