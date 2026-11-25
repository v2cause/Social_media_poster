import type { BrandContext, GenerateVariantsInput, VariantStreamEvent } from '@smp/core';
import { describe, expect, it } from 'vitest';

import type { ClaudeCliRunner, CliOutcome, CliRequest } from './claude-cli';
import { ClaudeCodeAiProvider } from './claude-code-ai-provider';

const brand: BrandContext = {
  profile: {
    name: 'Brand Studio',
    industry: 'Software',
    targetAudience: null,
    goals: null,
    contentPillars: [],
  },
  voice: null,
  customStyles: [],
};

const input: GenerateVariantsInput = {
  brand,
  styleKey: 'professional',
  targets: [
    { key: 't1', platform: 'LINKEDIN' },
    { key: 't2', platform: 'X' },
  ],
  language: 'de',
  brief: 'Der neue Kalender ist da.',
  mediaDescriptions: [],
};

const variant = (targetKey: string, platform: string, text: string) => ({
  targetKey,
  platform,
  hook: text,
  text,
  hashtags: ['kalender'],
  firstComment: null,
  callToAction: null,
  altTexts: [],
  warnings: [],
});

const VARIANTS = {
  variants: [variant('t1', 'LINKEDIN', 'Der neue Kalender ist da.'), variant('t2', 'X', 'Kalender ist da.')],
};

const resultLine = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(VARIANTS),
    structured_output: VARIANTS,
    stop_reason: 'end_turn',
    ttft_ms: 812.4,
    modelUsage: { 'claude-opus-5-5': { inputTokens: 10 } },
    ...overrides,
  });

const exited = (stdout: string, code = 0, stderr = ''): CliOutcome => ({
  kind: 'exited',
  code,
  stdout,
  stderr,
});

class FakeRunner implements ClaudeCliRunner {
  readonly requests: CliRequest[] = [];
  readonly files = new Map<string, string>();

  constructor(private readonly outcome: CliOutcome) {}

  writeFile(name: string, content: string): string {
    this.files.set(name, content);
    return `/private/${name}`;
  }

  run(request: CliRequest): Promise<CliOutcome> {
    this.requests.push(request);
    return Promise.resolve(this.outcome);
  }
}

const provider = (runner: ClaudeCliRunner) =>
  new ClaudeCodeAiProvider({ runner, model: 'claude-opus-5-5', timeoutMs: 60_000 });

async function collect(events: AsyncIterable<VariantStreamEvent>): Promise<VariantStreamEvent[]> {
  const all: VariantStreamEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

describe('ClaudeCodeAiProvider', () => {
  it('calls the CLI without tools, without --bare and with the schema and the effort', async () => {
    const runner = new FakeRunner(
      exited(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n${resultLine()}\n`),
    );

    await collect(provider(runner).generateVariants(input, { effort: 'medium' }));

    const args = runner.requests[0]?.args ?? [];
    expect(args).toEqual(expect.arrayContaining(['-p', '--model', 'claude-opus-5-5', '--effort', 'medium']));
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    expect(args).toContain('--strict-mcp-config');
    expect(args).not.toContain('--bare');
    expect(JSON.parse(args[args.indexOf('--json-schema') + 1] ?? '{}')).toMatchObject({ type: 'object' });
    const systemFile = args[args.indexOf('--system-prompt-file') + 1] ?? '';
    expect([...runner.files.values()][0]).toContain('Brand Studio');
    expect(systemFile.startsWith('/private/system-')).toBe(true);
  });

  it('sends the task as one user message on stdin', async () => {
    const runner = new FakeRunner(exited(resultLine()));

    await collect(provider(runner).generateVariants(input, { effort: 'medium' }));

    const message = JSON.parse(runner.requests[0]?.input ?? '{}') as {
      type: string;
      message: { role: string; content: { type: string; text: string }[] };
    };
    expect(message.type).toBe('user');
    expect(message.message.content[0]?.text).toContain('Der neue Kalender ist da.');
  });

  it('completes with the variants matched to the targets and a report without costs', async () => {
    const events = await collect(
      provider(new FakeRunner(exited(resultLine()))).generateVariants(input, { effort: 'medium' }),
    );

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event?.type).toBe('completed');
    if (event?.type === 'completed') {
      expect(event.variants.map((entry) => entry.targetKey)).toEqual(['t1', 't2']);
      expect(event.report).toMatchObject({
        provider: 'claude-code',
        modelServed: 'claude-opus-5-5',
        ttftMs: 812,
        attempts: [],
      });
    }
  });

  it('falls back to the text of the result when there is no structured output', async () => {
    const runner = new FakeRunner(exited(resultLine({ structured_output: undefined })));

    const events = await collect(provider(runner).generateVariants(input, { effort: 'medium' }));

    expect(events[0]?.type).toBe('completed');
  });

  it('fails as invalid output when the answer misses a target', async () => {
    const answer = { variants: [VARIANTS.variants[0]] };
    const runner = new FakeRunner(exited(resultLine({ structured_output: answer })));

    const events = await collect(provider(runner).generateVariants(input, { effort: 'medium' }));

    expect(events[0]).toMatchObject({ type: 'failed', failure: { code: 'INVALID_OUTPUT' } });
  });

  it('reports a missing CLI as a provider error that names the setting', async () => {
    const runner = new FakeRunner({ kind: 'not-found', binary: 'claude' });

    const result = await provider(runner).suggestAltText(
      { language: 'de', image: { kind: 'url', url: 'https://example.com/a.jpg' }, context: null },
      { effort: 'low' },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toMatchObject({ code: 'PROVIDER_ERROR', retryable: false });
      expect(result.failure.detail).toContain('CLAUDE_CODE_PATH');
    }
  });

  it('sends an image as a content block for the alt text', async () => {
    const runner = new FakeRunner(
      exited(resultLine({ structured_output: { altText: 'Ein rotes Quadrat' } })),
    );

    const result = await provider(runner).suggestAltText(
      { language: 'de', image: { kind: 'base64', mediaType: 'image/png', data: 'AAAA' }, context: null },
      { effort: 'low' },
    );

    expect(result).toMatchObject({ ok: true, value: 'Ein rotes Quadrat' });
    const message = JSON.parse(runner.requests[0]?.input ?? '{}') as {
      message: { content: { type: string }[] };
    };
    expect(message.message.content.map((block) => block.type)).toEqual(['image', 'text']);
  });

  it('passes the abort signal to the runner and maps an abort to CANCELED', async () => {
    const controller = new AbortController();
    const runner = new FakeRunner({ kind: 'aborted' });

    const events = await collect(
      provider(runner).generateVariants(input, { effort: 'medium', signal: controller.signal }),
    );

    expect(runner.requests[0]?.signal).toBe(controller.signal);
    expect(events[0]).toMatchObject({ type: 'failed', failure: { code: 'CANCELED' } });
  });
});
