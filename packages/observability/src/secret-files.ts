import { readFileSync } from 'node:fs';

// Secrets as files (guide step 8.9): the production template mounts every secret as a file of its
// own (Compose secrets under /run/secrets) and names it with <NAME>_FILE, instead of putting the
// value into the environment of the container, where `docker inspect` shows it. Every process
// resolves the files before it reads its configuration: @smp/observability/register and the env
// loaders of the apps call loadSecretFiles first.

/**
 * The variables that may come from a file: the secrets of the rotation runbook, including the
 * client secrets of the platform apps in .env.example. Others that end in _FILE (SSL_CERT_FILE)
 * stay as they are.
 */
export const SECRET_FILE_VARIABLES = [
  'ANTHROPIC_API_KEY',
  'BETTER_AUTH_SECRET',
  'BETTER_AUTH_SECRETS',
  'DATABASE_SYSTEM_URL',
  'DATABASE_URL',
  'INSTAGRAM_APP_SECRET',
  'LINKEDIN_CLIENT_SECRET',
  'LINKEDIN_CM_CLIENT_SECRET',
  'META_APP_SECRET',
  'NOTIFY_KEKS',
  'REDIS_URL',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'SENTRY_DSN',
  'SESSION_KEKS',
  'SMTP_URL',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'TOKEN_KEKS',
  'X_CLIENT_SECRET',
] as const;

/** A secret file that cannot be used. The message names the variable and the path, never content. */
export class SecretFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretFileError';
  }
}

/**
 * Reads every <NAME>_FILE of SECRET_FILE_VARIABLES into <NAME> and removes <NAME>_FILE, so that a
 * second call changes nothing. One line break at the end of the file is dropped.
 */
export function loadSecretFiles(env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_FILE_VARIABLES) {
    const fileVariable = `${name}_FILE`;
    const path = env[fileVariable];
    if (path === undefined || path === '') {
      continue;
    }
    if (env[name] !== undefined && env[name] !== '') {
      throw new SecretFileError(`Set ${name} or ${fileVariable}, not both.`);
    }
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      throw new SecretFileError(`${fileVariable}: ${path} cannot be read.`);
    }
    const value = content.replace(/\r?\n$/, '');
    if (value === '') {
      throw new SecretFileError(`${fileVariable}: ${path} is empty.`);
    }
    env[name] = value;
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- the name comes from the list above
    delete env[fileVariable];
  }
}
