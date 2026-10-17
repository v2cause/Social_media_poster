import { X_BROWSER_RISK, type XBrowserStatusDto } from '@smp/contracts';
import { describe, expect, it } from 'vitest';

import { riskBlocksOf, viewOf } from './x-browser-model';

const status = (patch: Partial<XBrowserStatusDto>): XBrowserStatusDto => ({
  available: false,
  blocks: [],
  enabled: false,
  currentVersion: '2026-10-17',
  acknowledgement: null,
  ...patch,
});

describe('viewOf', () => {
  it('explains the first condition the workspace cannot lift', () => {
    expect(viewOf(status({ blocks: ['deployment', 'plan', 'workspace', 'acknowledgement'] }))).toEqual({
      kind: 'unavailable',
      reason: 'deployment',
      enabled: false,
    });
    expect(viewOf(status({ blocks: ['kill_switch'], enabled: true }))).toEqual({
      kind: 'unavailable',
      reason: 'kill_switch',
      enabled: true,
    });
  });

  it('tells switched on, a changed text and switched off apart', () => {
    expect(viewOf(status({ available: true, enabled: true }))).toEqual({ kind: 'enabled' });
    expect(viewOf(status({ blocks: ['acknowledgement'], enabled: true }))).toEqual({ kind: 'renew' });
    expect(viewOf(status({ blocks: ['workspace', 'acknowledgement'] }))).toEqual({ kind: 'off' });
  });
});

describe('riskBlocksOf', () => {
  it('splits the risk text into paragraphs and one list of terms', () => {
    for (const text of Object.values(X_BROWSER_RISK.texts)) {
      const blocks = riskBlocksOf(text);
      expect(blocks.map((block) => block.kind)).toEqual(['paragraph', 'list', 'paragraph']);
      const list = blocks[1];
      expect(list?.kind === 'list' ? list.items.length : 0).toBe(7);
      expect(list?.kind === 'list' ? list.items.every((item) => item.term !== null) : false).toBe(true);
    }
  });

  it('keeps a point without a term whole', () => {
    expect(riskBlocksOf('Intro\n\n- one point\n- Term: text')).toEqual([
      { kind: 'paragraph', text: 'Intro' },
      {
        kind: 'list',
        items: [
          { term: null, text: 'one point' },
          { term: 'Term', text: 'text' },
        ],
      },
    ]);
  });
});
