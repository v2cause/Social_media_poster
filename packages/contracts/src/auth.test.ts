import { describe, expect, it } from 'vitest';

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, resetPasswordSchema, signUpSchema } from './auth';

describe('auth form schemas', () => {
  const signUp = {
    name: 'Ada Lovelace',
    email: 'ada@example.test',
    password: 'a'.repeat(PASSWORD_MIN_LENGTH),
  };

  it('accepts a password within the limits Better Auth enforces', () => {
    expect(signUpSchema.safeParse(signUp).success).toBe(true);
    expect(signUpSchema.safeParse({ ...signUp, password: 'a'.repeat(PASSWORD_MAX_LENGTH) }).success).toBe(
      true,
    );
  });

  it('rejects passwords outside the limits', () => {
    expect(signUpSchema.safeParse({ ...signUp, password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1) }).success).toBe(
      false,
    );
    expect(signUpSchema.safeParse({ ...signUp, password: 'a'.repeat(PASSWORD_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
  });

  it('rejects a blank name and an invalid address', () => {
    expect(signUpSchema.safeParse({ ...signUp, name: '   ' }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...signUp, email: 'not-an-email' }).success).toBe(false);
  });

  it('reports a differing confirmation on the confirm field', () => {
    const result = resetPasswordSchema.safeParse({ password: 'a'.repeat(12), confirm: 'b'.repeat(12) });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({ path: ['confirm'], message: 'passwords_differ' }),
    ]);
  });
});
