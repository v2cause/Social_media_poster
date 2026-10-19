import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { loadSecretFiles, SecretFileError } from './secret-files';

const dir = mkdtempSync(join(tmpdir(), 'smp-secret-files-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const secretFile = (name: string, content: string): string => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe('loadSecretFiles', () => {
  it('reads a secret from its file, drops the line break and removes the _FILE variable', () => {
    const env: NodeJS.ProcessEnv = { TOKEN_KEKS_FILE: secretFile('token-keks', 'kek-1:abc=\n') };

    loadSecretFiles(env);

    expect(env).toEqual({ TOKEN_KEKS: 'kek-1:abc=' });
  });

  it('treats an empty value from Compose as unset', () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: '',
      DATABASE_URL_FILE: secretFile('database-url', 'postgresql://app_user:pw@postgres:5432/smp'),
    };

    loadSecretFiles(env);

    expect(env['DATABASE_URL']).toBe('postgresql://app_user:pw@postgres:5432/smp');
  });

  it('changes nothing on a second call', () => {
    const env: NodeJS.ProcessEnv = { REDIS_URL_FILE: secretFile('redis-url', 'rediss://api:pw@redis:6379') };

    loadSecretFiles(env);
    loadSecretFiles(env);

    expect(env).toEqual({ REDIS_URL: 'rediss://api:pw@redis:6379' });
  });

  it('refuses a value and a file for the same variable', () => {
    const env: NodeJS.ProcessEnv = {
      STRIPE_SECRET_KEY: 'sk_test_value',
      STRIPE_SECRET_KEY_FILE: secretFile('stripe', 'sk_test_file'),
    };

    expect(() => {
      loadSecretFiles(env);
    }).toThrow(new SecretFileError('Set STRIPE_SECRET_KEY or STRIPE_SECRET_KEY_FILE, not both.'));
  });

  it('names the variable and the path of a missing or empty file, never content', () => {
    const missing = join(dir, 'missing');
    const empty = secretFile('empty', '\n');

    expect(() => {
      loadSecretFiles({ SMTP_URL_FILE: missing });
    }).toThrow(`SMTP_URL_FILE: ${missing} cannot be read.`);
    expect(() => {
      loadSecretFiles({ SENTRY_DSN_FILE: empty });
    }).toThrow(`SENTRY_DSN_FILE: ${empty} is empty.`);
  });

  it('leaves variables alone that are no secrets of the list', () => {
    const env: NodeJS.ProcessEnv = { SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' };

    loadSecretFiles(env);

    expect(env).toEqual({ SSL_CERT_FILE: '/etc/ssl/certs/ca-certificates.crt' });
  });
});
