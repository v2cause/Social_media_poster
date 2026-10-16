import { describe, expect, it } from 'vitest';

import { assertSafeAuditMetadata, UnsafeAuditMetadataError } from './audit-metadata';

describe('assertSafeAuditMetadata', () => {
  it('accepts descriptive metadata', () => {
    expect(() => {
      assertSafeAuditMetadata({ role: 'EDITOR', from: 'VIEWER', workspaceIds: [] });
    }).not.toThrow();
    expect(() => {
      assertSafeAuditMetadata(undefined);
    }).not.toThrow();
  });

  it.each(['token', 'tokenHash', 'clientSecret', 'password', 'apiKey', 'api_key', 'Authorization'])(
    'refuses the key %s',
    (key) => {
      expect(() => {
        assertSafeAuditMetadata({ [key]: 'x' });
      }).toThrow(UnsafeAuditMetadataError);
    },
  );
});
