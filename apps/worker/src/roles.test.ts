import { describe, expect, it } from 'vitest';

import { parseRoles } from './roles';

describe('parseRoles', () => {
  it('parses a comma-separated list and ignores surrounding spaces', () => {
    expect(parseRoles(' scheduler , publisher ')).toEqual(['scheduler', 'publisher']);
  });

  it('removes duplicates while keeping the first occurrence', () => {
    expect(parseRoles('media,scheduler,media')).toEqual(['media', 'scheduler']);
  });

  it('rejects an empty list', () => {
    expect(() => parseRoles(' , ')).toThrow(/at least one role/);
  });

  it('names the unknown roles', () => {
    expect(() => parseRoles('scheduler,mailer')).toThrow(/Unknown worker role\(s\): mailer/);
  });
});
