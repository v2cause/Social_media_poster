import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { childEnvironment, SpawnClaudeCliRunner } from './claude-cli';

// A stand-in for the claude binary: a Node script that echoes its stdin, its arguments and two
// environment variables, or sleeps when asked to.
function fakeCli(): string {
  const directory = mkdtempSync(join(tmpdir(), 'smp-fake-claude-'));
  const path = join(directory, 'claude');
  writeFileSync(
    path,
    [
      `#!${process.execPath}`,
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  if (process.argv.includes('--sleep')) { setTimeout(() => undefined, 60_000); return; }",
      '  process.stdout.write(JSON.stringify({',
      '    input, args: process.argv.slice(2),',
      '    apiKey: process.env.ANTHROPIC_API_KEY ?? null, database: process.env.DATABASE_URL ?? null,',
      "    cwd: process.cwd() }) + '\\n');",
      '});',
    ].join('\n'),
  );
  chmodSync(path, 0o755);
  return path;
}

describe('SpawnClaudeCliRunner', () => {
  it('passes the arguments and stdin without a shell and keeps secrets out of the child', async () => {
    const env = childEnvironment({
      PATH: process.env['PATH'],
      ANTHROPIC_API_KEY: 'sk-test',
      DATABASE_URL: 'postgres://x',
    });
    const runner = new SpawnClaudeCliRunner(fakeCli(), env);

    const outcome = await runner.run({
      args: ['-p', '--tools', '', '$(whoami)'],
      input: 'hello',
      timeoutMs: 10_000,
    });

    expect(outcome.kind).toBe('exited');
    if (outcome.kind === 'exited') {
      const echo = JSON.parse(outcome.stdout) as {
        input: string;
        args: string[];
        apiKey: string | null;
        database: string | null;
        cwd: string;
      };
      expect(echo.input).toBe('hello');
      expect(echo.args).toEqual(['-p', '--tools', '', '$(whoami)']);
      expect(echo.apiKey).toBeNull();
      expect(echo.database).toBeNull();
      expect(echo.cwd).toContain('smp-claude-');
    }
  });

  it('reports a missing binary', async () => {
    const outcome = await new SpawnClaudeCliRunner('/nonexistent/claude').run({
      args: [],
      input: '',
      timeoutMs: 5_000,
    });

    expect(outcome).toEqual({ kind: 'not-found', binary: '/nonexistent/claude' });
  });

  it('stops the child after the timeout', async () => {
    const runner = new SpawnClaudeCliRunner(fakeCli(), childEnvironment(process.env));

    expect(await runner.run({ args: ['--sleep'], input: '', timeoutMs: 300 })).toEqual({ kind: 'timeout' });
  });

  it('stops the child when the call is aborted', async () => {
    const runner = new SpawnClaudeCliRunner(fakeCli(), childEnvironment(process.env));
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 200);

    expect(
      await runner.run({ args: ['--sleep'], input: '', timeoutMs: 10_000, signal: controller.signal }),
    ).toEqual({ kind: 'aborted' });
  });

  it('writes files into its private directory', () => {
    const runner = new SpawnClaudeCliRunner('claude');

    expect(runner.writeFile('system.md', 'x')).toContain('smp-claude-');
  });
});
