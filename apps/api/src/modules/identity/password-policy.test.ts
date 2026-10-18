import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@smp/contracts';
import { describe, expect, it, vi } from 'vitest';

import { contextWords, localPasswordProblem, PasswordPolicy, PRODUCT_WORDS } from './password-policy';

// Guide step 8.4 (ASVS 6.2.4 and 6.2.11): the most common passwords that the length allows and
// passwords with a word of their context are refused; a breach check comes on top.

const ada = { email: 'Ada.Lovelace@Analytical-Engines.example', name: 'Ada Lovelace' };

describe('the list of common passwords', () => {
  const entries = readFileSync(join(__dirname, 'common-passwords.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.length > 0 && !line.startsWith('#'));

  it('holds the 10,000 most common passwords the length allows, lowercased and once each', () => {
    expect(entries).toHaveLength(10_000);
    expect(new Set(entries).size).toBe(entries.length);
    for (const entry of entries) {
      expect(entry.length).toBeGreaterThanOrEqual(PASSWORD_MIN_LENGTH);
      expect(entry.length).toBeLessThanOrEqual(PASSWORD_MAX_LENGTH);
      expect(entry).toBe(entry.toLowerCase());
    }
  });

  it('refuses its passwords, whatever their case', () => {
    expect(localPasswordProblem('1qaz2wsx3edc', {})).toBe('PASSWORD_TOO_COMMON');
    expect(localPasswordProblem('1QAZ2WSX3EDC', {})).toBe('PASSWORD_TOO_COMMON');
    expect(localPasswordProblem(entries.at(-1) ?? '', {})).toBe('PASSWORD_TOO_COMMON');
  });
});

describe('the context words', () => {
  it('are the product, the address with its local part and domain labels, and the name with its parts', () => {
    expect(contextWords(ada)).toEqual([
      ...PRODUCT_WORDS,
      'adalovelaceanalyticalenginesexample',
      'adalovelace',
      'analyticalengines',
      'lovelace',
    ]);
  });

  it('refuse a password that contains one of them, whatever the case and the separators', () => {
    expect(localPasswordProblem('my name is LOVE-lace 1815', ada)).toBe('PASSWORD_CONTAINS_CONTEXT');
    expect(localPasswordProblem('analytical engines rock', ada)).toBe('PASSWORD_CONTAINS_CONTEXT');
    expect(localPasswordProblem('Social Media Poster 2026', {})).toBe('PASSWORD_CONTAINS_CONTEXT');
  });

  it('leave short parts and sound passphrases alone', () => {
    // "Ada" has three letters only.
    expect(localPasswordProblem('ada counts the stars at night', ada)).toBeNull();
    expect(localPasswordProblem('quiet river under the old bridge', ada)).toBeNull();
  });
});

describe('PasswordPolicy', () => {
  it('asks the breach check only for passwords the local checks pass', async () => {
    const breached = vi.fn(() => Promise.resolve(true));
    const policy = new PasswordPolicy(breached);

    await expect(policy.problem('1qaz2wsx3edc', {})).resolves.toBe('PASSWORD_TOO_COMMON');
    expect(breached).not.toHaveBeenCalled();
    await expect(policy.problem('quiet river under the old bridge', ada)).resolves.toBe(
      'PASSWORD_COMPROMISED',
    );
    expect(breached).toHaveBeenCalledWith('quiet river under the old bridge');
  });

  it('accepts a password that is neither common, nor of its context, nor breached', async () => {
    const policy = new PasswordPolicy(() => Promise.resolve(false));
    await expect(policy.problem('quiet river under the old bridge', ada)).resolves.toBeNull();
  });
});
