import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { generateKeys } from '../lib/keys';
import { startMediaProxy, startQuickTunnel } from './media-tunnel';

// `pnpm local`: starts the app for one person on this machine (ADR 0046). No sign-in, no billing,
// and the AI runs on the Claude subscription through the Claude Code CLI (ADR 0047).
//
// 1. Creates .env from .env.example on the first run and fills in the secrets that are still empty.
// 2. Checks that the claude CLI answers; generation needs it, everything else works without.
// 3. Starts Postgres, Redis, the storage and Mailpit with Docker Compose, builds the packages and
//    applies the migrations.
// 4. Starts API, worker and web in development mode. The API listens on 127.0.0.1 only.
//
// A platform whose app credentials are in .env runs with its real adapter and posts for real
// (PUBLISH_DRY_RUN=false); a platform without them is not offered, never the mock. With Meta live
// and cloudflared installed, a quick tunnel lets Instagram fetch the images (media-tunnel.ts).
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

/**
 * Bare names such as pnpm or docker are .cmd shims on Windows that only start through the shell; an
 * absolute path (node itself) may contain spaces and runs without it.
 */
const needsShell = (command: string): boolean => onWindows && !isAbsolute(command);

/**
 * pnpm as it started this script: through `corepack pnpm` it is not on PATH, but npm_execpath
 * names its entry point.
 */
function pnpm(args: string[]): [string, string[]] {
  const entry = process.env['npm_execpath'];
  return entry && /\.c?js$/.test(entry) ? [process.execPath, [entry, ...args]] : ['pnpm', args];
}

/** Runs a fixed command and stops when it fails. The arguments never contain user input. */
function run(command: string, args: string[], label: string, env: NodeJS.ProcessEnv = process.env): void {
  say(label);
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env, shell: needsShell(command) });
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

/** The values of .env, without comments and quotes; enough for the checks of this script. */
function readEnvFile(): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1]) {
      values[match[1]] = (match[2] ?? '').replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return values;
}

/** The credentials each platform setting needs before its real adapter can run. */
const PLATFORM_CREDENTIALS: Readonly<Record<string, { label: string; variables: readonly string[] }>> = {
  PLATFORM_MODE_LINKEDIN: { label: 'LinkedIn', variables: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] },
  PLATFORM_MODE_META: { label: 'Facebook and Instagram', variables: ['META_APP_ID', 'META_APP_SECRET'] },
  PLATFORM_MODE_X: { label: 'X', variables: ['X_CLIENT_ID', 'X_CLIENT_SECRET'] },
};

/** live where the credentials are set, otherwise off. */
function platformModes(values: Record<string, string>): Record<string, string> {
  const modes: Record<string, string> = {};
  for (const [setting, { label, variables }] of Object.entries(PLATFORM_CREDENTIALS)) {
    const complete = variables.every((name) => (process.env[name] ?? values[name] ?? '') !== '');
    modes[setting] = complete ? 'live' : 'off';
    say(
      complete
        ? `${label}: connected with your app (${variables.join(', ')})`
        : `${label}: not set up; add ${variables.join(' and ')} to .env (see docs/plattformen-einrichten.md)`,
    );
  }
  return modes;
}

/**
 * Instagram needs the images under a public URL. Without META_PUBLIC_MEDIA_BASE_URL a quick tunnel
 * to the read-only proxy provides one; without cloudflared, Instagram cannot publish images.
 */
async function openMediaTunnel(values: Record<string, string>): Promise<(() => void) | null> {
  if ((process.env['META_PUBLIC_MEDIA_BASE_URL'] ?? values['META_PUBLIC_MEDIA_BASE_URL'] ?? '') !== '') {
    return null;
  }
  const storageUrl = process.env['S3_ENDPOINT'] ?? values['S3_ENDPOINT'] ?? 'http://127.0.0.1:8333';
  const { server, port } = await startMediaProxy(storageUrl);
  const binary = process.env['CLOUDFLARED_PATH'] ?? values['CLOUDFLARED_PATH'] ?? 'cloudflared';
  const tunnel = await startQuickTunnel(binary, port, needsShell(binary));
  if (!tunnel) {
    server.close();
    say('Instagram: cloudflared was not found or opened no tunnel, so Instagram cannot fetch images.');
    say('Install it (see docs/plattformen-einrichten.md) or set META_PUBLIC_MEDIA_BASE_URL in .env.');
    return null;
  }
  env['META_PUBLIC_MEDIA_BASE_URL'] = tunnel.url;
  say(`Instagram: images are served read-only through ${tunnel.url}`);
  return () => {
    tunnel.process.kill();
    server.close();
  };
}

prepareEnvFile();
const envValues = readEnvFile();

// Process variables win over .env in every app, so these settings apply whatever .env says.
const env: NodeJS.ProcessEnv = {
  ...process.env,
  LOCAL_MODE: 'true',
  API_HOST: '127.0.0.1',
  AI_PROVIDER: process.env['AI_PROVIDER'] ?? 'claude-code',
  ...platformModes(envValues),
  PUBLISH_DRY_RUN: 'false',
  TURBO_TELEMETRY_DISABLED: '1',
  NEXT_TELEMETRY_DISABLED: '1',
};

if (env['AI_PROVIDER'] === 'claude-code') {
  checkClaudeCli(env['CLAUDE_CODE_PATH'] ?? 'claude');
}

async function main(): Promise<void> {
  run('docker', ['compose', 'up', '-d', '--wait'], 'starting Postgres, Redis, storage and Mailpit (Docker)');
  // The apps load the packages from their dist folders; a fresh clone has none yet. Turbo skips what
  // is already built.
  run(
    ...pnpm([
      'exec',
      'turbo',
      'run',
      'build',
      '--filter=@smp/api^...',
      '--filter=@smp/worker^...',
      '--filter=@smp/web^...',
    ]),
    'building the packages',
    env,
  );
  run(...pnpm(['--filter', '@smp/db', 'migrate:deploy']), 'applying the database migrations', env);

  const closeTunnel = env['PLATFORM_MODE_META'] === 'live' ? await openMediaTunnel(envValues) : null;

  say('starting API, worker and web. Open http://localhost:3000 once the web app is ready.');
  const [command, args] = pnpm([
    'exec',
    'turbo',
    'run',
    'dev',
    '--env-mode=loose',
    '--filter=@smp/api',
    '--filter=@smp/worker',
    '--filter=@smp/web',
  ]);
  const apps = spawn(command, args, { cwd: root, stdio: 'inherit', env, shell: needsShell(command) });
  const stop = (): void => {
    apps.kill('SIGINT');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  apps.on('exit', (code) => {
    closeTunnel?.();
    process.exit(code ?? 0);
  });
}

void main();
