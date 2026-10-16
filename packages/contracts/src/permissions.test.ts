import { describe, expect, it } from 'vitest';

import { can, PERMISSIONS, ROLE_PERMISSIONS, ROLES } from './permissions';

describe('permission matrix', () => {
  it('matches the table of the architecture', () => {
    expect(can('OWNER', 'billing.manage')).toBe(true);
    expect(can('ADMIN', 'billing.manage')).toBe(false);
    expect(can('ADMIN', 'member.manage')).toBe(true);
    expect(can('EDITOR', 'member.manage')).toBe(false);
    expect(can('EDITOR', 'post.publish')).toBe(true);
    expect(can('VIEWER', 'post.write')).toBe(false);
    expect(can('VIEWER', 'analytics.read')).toBe(true);
  });

  it('gives every higher role all permissions of the lower ones', () => {
    for (let index = 1; index < ROLES.length; index += 1) {
      const higher = ROLES[index - 1];
      const lower = ROLES[index];
      if (higher && lower) {
        expect(ROLE_PERMISSIONS[higher]).toEqual(expect.arrayContaining([...ROLE_PERMISSIONS[lower]]));
      }
    }
  });

  it('assigns every permission to the owner', () => {
    expect([...ROLE_PERMISSIONS.OWNER].sort()).toEqual([...PERMISSIONS].sort());
  });
});
