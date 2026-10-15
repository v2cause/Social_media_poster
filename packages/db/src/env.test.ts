import { describe, expect, it } from 'vitest';

import { dbEnvSchema } from './env';

const validEnv = {
  DATABASE_URL: 'postgresql://app_user:secret-user@127.0.0.1:5432/smp',
  DATABASE_SYSTEM_URL: 'postgresql://app_system:secret-system@127.0.0.1:5432/smp',
  MIGRATION_DATABASE_URL: 'postgresql://app_migrator:secret-migrator@127.0.0.1:5432/smp',
};

describe('dbEnvSchema', () => {
  it('accepts three PostgreSQL URLs', () => {
    expect(dbEnvSchema.safeParse(validEnv).success).toBe(true);
  });

  it('reports a missing role URL by its variable name', () => {
    const withoutAppUser = {
      DATABASE_SYSTEM_URL: validEnv.DATABASE_SYSTEM_URL,
      MIGRATION_DATABASE_URL: validEnv.MIGRATION_DATABASE_URL,
    };

    const result = dbEnvSchema.safeParse(withoutAppUser);

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('DATABASE_URL');
  });

  it('rejects URLs that are not PostgreSQL URLs', () => {
    const result = dbEnvSchema.safeParse({ ...validEnv, DATABASE_URL: 'mysql://app_user@127.0.0.1/smp' });

    expect(result.success).toBe(false);
  });

  it('keeps the rejected value out of the error message', () => {
    const rejectedValue = 'not-a-url-but-a-secret-7f3a9c';

    const result = dbEnvSchema.safeParse({ ...validEnv, DATABASE_URL: rejectedValue });

    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain(rejectedValue);
  });
});
