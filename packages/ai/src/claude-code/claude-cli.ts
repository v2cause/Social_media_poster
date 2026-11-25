import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs the Claude Code CLI as a child process (ADR 0047). The CLI signs in with the user's Claude
// subscription, so no API key is involved:
//
// - No shell: the arguments go to the binary as they are, nothing is quoted or interpreted.
// - An empty working directory of its own, so no CLAUDE.md or project settings are picked up.
// - A reduced environment. ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN are never passed on: with
//   either of them the CLI would bill the API instead of the subscription. The app's own secrets
//   (database, storage, keys) do not reach the child either.

/** Variables the CLI needs to find its login, its config and the network. */
const PASSED_VARIABLES = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TMP',
  'TEMP',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  // Windows
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'PATHEXT',
  'HOMEDRIVE',
  'HOMEPATH',
];

export function childEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of PASSED_VARIABLES) {
    const value = source[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

export interface CliRequest {
  args: readonly string[];
  /** Written to the child's stdin, then stdin is closed. */
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type CliOutcome =
  | { kind: 'exited'; code: number | null; stdout: string; stderr: string }
  | { kind: 'not-found'; binary: string }
  | { kind: 'spawn-failed'; message: string }
  | { kind: 'timeout' }
  | { kind: 'aborted' };

export interface ClaudeCliRunner {
  /** A file in the runner's private directory, for content too long for an argument. */
  writeFile(name: string, content: string): string;
  run(request: CliRequest): Promise<CliOutcome>;
}

/** Output beyond this is cut off; a structured answer is far smaller. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export class SpawnClaudeCliRunner implements ClaudeCliRunner {
  private directory: string | undefined;

  constructor(
    private readonly binary: string,
    private readonly environment: NodeJS.ProcessEnv = childEnvironment(process.env),
  ) {}

  writeFile(name: string, content: string): string {
    const path = join(this.workingDirectory(), name);
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
    return path;
  }

  run(request: CliRequest): Promise<CliOutcome> {
    if (request.signal?.aborted) {
      return Promise.resolve({ kind: 'aborted' });
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome: CliOutcome): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener('abort', onAbort);
          resolve(outcome);
        }
      };

      const child = spawn(this.binary, [...request.args], {
        cwd: this.workingDirectory(),
        env: this.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let size = 0;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        size += chunk.length;
        if (size <= MAX_OUTPUT_BYTES) {
          target.push(chunk);
        }
      };
      child.stdout.on('data', collect(stdout));
      child.stderr.on('data', collect(stderr));

      const stop = (outcome: CliOutcome): void => {
        child.kill('SIGTERM');
        settle(outcome);
      };
      const onAbort = (): void => {
        stop({ kind: 'aborted' });
      };
      const timer = setTimeout(() => {
        stop({ kind: 'timeout' });
      }, request.timeoutMs);
      request.signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error: NodeJS.ErrnoException) => {
        settle(
          error.code === 'ENOENT'
            ? { kind: 'not-found', binary: this.binary }
            : { kind: 'spawn-failed', message: error.code ?? error.name },
        );
      });
      child.on('close', (code) => {
        settle({
          kind: 'exited',
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        });
      });
      // A child that exits before reading stdin closes the pipe; the exit code tells the story.
      child.stdin.on('error', () => undefined);
      child.stdin.end(request.input);
    });
  }

  private workingDirectory(): string {
    this.directory ??= mkdtempSync(join(tmpdir(), 'smp-claude-'));
    return this.directory;
  }
}
