import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The password policy beyond the length (guide step 8.4, ADR 0039, ASVS 6.2.4, 6.2.11 and
// 6.2.12). A new password, at sign-up, reset or change, is refused when it is one of the most
// common passwords, when it contains a word of its context (the name of the product, the address
// or the name of the user), or when it appeared in a known breach.

export type PasswordProblem = 'PASSWORD_TOO_COMMON' | 'PASSWORD_CONTAINS_CONTEXT' | 'PASSWORD_COMPROMISED';

/** The name of the product in the forms a password would take it. */
export const PRODUCT_WORDS: readonly string[] = ['socialmediaposter', 'socialmedia', 'mediaposter'];
/** Shorter parts of a name or an address are too common to refuse. */
export const MIN_CONTEXT_WORD_LENGTH = 4;

/** Who the password belongs to, as far as the request tells. */
export interface PasswordContext {
  email?: string | null;
  name?: string | null;
}

/** Lowercase letters and digits only, so that "Ada.Lovelace!" and "ada lovelace" compare equal. */
const normalize = (text: string): string =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

let common: ReadonlySet<string> | null = null;

/** The list of common-passwords.txt (lowercased, one per line, # starts a comment). */
function commonPasswords(): ReadonlySet<string> {
  if (!common) {
    const lines = readFileSync(join(__dirname, 'common-passwords.txt'), 'utf8').split('\n');
    common = new Set(lines.filter((line) => line.length > 0 && !line.startsWith('#')));
  }
  return common;
}

/** The documented context words of a user: the product, the address, its parts and the name. */
export function contextWords({ email, name }: PasswordContext): string[] {
  const words = new Set(PRODUCT_WORDS);
  const add = (word: string): void => {
    const normalized = normalize(word);
    if (normalized.length >= MIN_CONTEXT_WORD_LENGTH) {
      words.add(normalized);
    }
  };
  if (email) {
    const [local = '', domain = ''] = email.split('@');
    add(email);
    add(local);
    // The labels of the domain without the top-level one, as in "acme" of "ada@acme.example".
    for (const label of domain.split('.').slice(0, -1)) {
      add(label);
    }
  }
  if (name) {
    add(name);
    for (const part of name.split(/[\s.,_-]+/)) {
      add(part);
    }
  }
  return [...words];
}

/** What the local checks find wrong with a new password; the breach check comes on top. */
export function localPasswordProblem(password: string, context: PasswordContext): PasswordProblem | null {
  if (commonPasswords().has(password.toLowerCase())) {
    return 'PASSWORD_TOO_COMMON';
  }
  const normalized = normalize(password);
  if (contextWords(context).some((word) => normalized.includes(word))) {
    return 'PASSWORD_CONTAINS_CONTEXT';
  }
  return null;
}

/** Whether a password appeared in a known breach; false when the check could not tell. */
export type BreachCheck = (password: string) => Promise<boolean>;

/** The local checks first; only a password that passes them goes to the breach check. */
export class PasswordPolicy {
  constructor(private readonly breached: BreachCheck) {}

  async problem(password: string, context: PasswordContext): Promise<PasswordProblem | null> {
    const local = localPasswordProblem(password, context);
    if (local) {
      return local;
    }
    return (await this.breached(password)) ? 'PASSWORD_COMPROMISED' : null;
  }
}
