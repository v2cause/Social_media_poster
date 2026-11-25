import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { generateKeys } from '../lib/keys';

// `pnpm local`: starts the app for one person on this machine (ADR 0046). No sign-in, no billing,
// and the AI runs on the Claude subscription through the Claude Code CLI (ADR 0047).
//
// 1. Creates .env from .env.example on the first run and fills in the secrets that are still empty.
// 2. Checks that the claude CLI answers; generation needs it, everything else works without.
// 3. Starts Postgres, Redis, the storage and Mailpit with Docker Compose, builds the packages and
//    applies the migrations.
// 4. Starts API, worker and web in development mode. The API listens on 127.0.0.1 only.
//
// Stop it with Ctrl+C. The data stays in the Docker volumes for the next start.

const root = resolve(__dirname, '../..');
const envFile = resolve(root, '.env');
const onWindows = process.platform === 'win32';

const say = (message: string): void => {
  process.stdout.write(`[local] ${message}\n`);
};

function fail(message: string): never {
  process.stderr.write(`[local] ${message}\n`);
  process.exit(1);
}

/** Runs a fixed command and stops when it fails. The arguments never contain user input. */
function run(command: string, args: string[], label: string, env: NodeJS.ProcessEnv = process.env): void {
  say(label);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env, shell: onWindows });
  if (result.error || result.status !== 0) {
    fail(`${label} failed. See the output above.`);
  }
}

/** Creates .env and fills empty secrets with fresh ones; existing values are never changed. */
function prepareEnvFile(): void {
  if (!existsSync(envFile)) {
    copyFileSync(resolve(root, '.env.example'), envFile);
    say('created .env from .env.example');
  }
  let content = readFileSync(envFile, 'utf8');
  const filled: string[] = [];
  for (const [name, value] of Object.entries(generateKeys())) {
    const line = new RegExp(`^${name}=[ \\t]*$`, 'm');
    if (line.test(content)) {
      content = content.replace(line, `${name}=${value}`);
      filled.push(name);
    } else if (!new RegExp(`^${name}=`, 'm').test(content)) {
      content += `\n${name}=${value}\n`;
      filled.push(name);
    }
  }
  if (filled.length > 0) {
    writeFileSync(envFile, content, { mode: 0o600 });
    say(`generated ${filled.join(', ')} in .env`);
  }
}

function checkClaudeCli(binary: string): void {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', shell: onWindows });
  if (result.error || result.status !== 0) {
    say(`the claude CLI was not found (${binary}). Install Claude Code, run "claude" once and log in`);
    say('with your Claude subscription. Until then, generating posts and diagrams fails.');
    return;
  }
  say(`Claude Code ${result.stdout.trim()} found; posts are generated with your Claude subscription`);
}

prepareEnvFile();

// Process variables win over .env in every app, so these settings apply whatever .env says.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOCAL_MODE: 'true',
  API_HOST: '127.0.0.1',
  AI_PROVIDER: process.env['AI_PROVIDER'] ?? 'claude-code',
  TURBO_TELEMETRY_DISABLED: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

if (env['AI_PROVIDER'] === 'claude-code') {
  checkClaudeCli(env['CLAUDE_CODE_PATH'] ?? 'claude');
}

run('docker', ['compose', 'up', '-d', '--wait'], 'starting Postgres, Redis, storage and Mailpit (Docker)');
// The apps load the packages from their dist folders; a fresh clone has none yet. Turbo skips what
// is already built.
run(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'build',
    '--filter=@smp/api^...',
    '--filter=@smp/worker^...',
    '--filter=@smp/web^...',
  ],
  'building the packages',
  env,
);
run('pnpm', ['--filter', '@smp/db', 'migrate:deploy'], 'applying the database migrations', env);

say('starting API, worker and web. Open http://localhost:3000 once the web app is ready.');
const apps = spawn(
  'pnpm',
  [
    'exec',
    'turbo',
    'run',
    'dev',
    '--env-mode=loose',
    '--filter=@smp/api',
    '--filter=@smp/worker',
    '--filter=@smp/web',
  ],
  { cwd: root, stdio: 'inherit', env, shell: onWindows },
);
const stop = (): void => {
  apps.kill('SIGINT');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
apps.on('exit', (code) => {
  process.exit(code ?? 0);
});
