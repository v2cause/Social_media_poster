import { PLATFORMS } from '@smp/platform-rules';
import { describe, expect, it } from 'vitest';

import {
  confirmConnectionSchema,
  pendingConnectionIdSchema,
  PLATFORM_SLUGS,
  platformOfSlug,
  slugOfPlatform,
} from './channels';

describe('channel requests', () => {
  it('maps every platform to its slug in the paths and back', () => {
    expect(PLATFORMS.map(slugOfPlatform)).toEqual(PLATFORM_SLUGS);
    expect(PLATFORM_SLUGS.map(platformOfSlug)).toEqual(PLATFORMS);
  });

  it('takes the id of a pending connection only in its own shape', () => {
    expect(pendingConnectionIdSchema.safeParse('a'.repeat(43)).success).toBe(true);
    expect(pendingConnectionIdSchema.safeParse('a'.repeat(42)).success).toBe(false);
    expect(pendingConnectionIdSchema.safeParse(`${'a'.repeat(42)}/`).success).toBe(false);
  });

  it('confirms at least one account', () => {
    expect(confirmConnectionSchema.safeParse({ externalIds: [] }).success).toBe(false);
    expect(confirmConnectionSchema.safeParse({ externalIds: ['urn:li:person:1'] }).success).toBe(true);
  });
});
