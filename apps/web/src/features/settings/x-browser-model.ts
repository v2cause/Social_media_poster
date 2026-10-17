import type { XBrowserStatusDto } from '@smp/contracts';

// What the settings show of the X browser (guide step 6.1), and the risk text as blocks for the
// page. The text is plain Markdown with paragraphs and one list whose points start with a term.

/** The conditions the workspace cannot lift itself, in the order they are explained. */
const OUTSIDE = ['deployment', 'kill_switch', 'plan'] as const;
export type OutsideBlock = (typeof OUTSIDE)[number];

export type XBrowserView =
  /** The deployment, the kill switch or the plan keeps it closed. */
  | { kind: 'unavailable'; reason: OutsideBlock; enabled: boolean }
  | { kind: 'enabled' }
  /** Switched on, but the text changed since the acknowledgement. */
  | { kind: 'renew' }
  | { kind: 'off' };

export function viewOf(status: XBrowserStatusDto): XBrowserView {
  const reason = OUTSIDE.find((block) => status.blocks.includes(block));
  if (reason) {
    return { kind: 'unavailable', reason, enabled: status.enabled };
  }
  if (status.enabled) {
    return status.available ? { kind: 'enabled' } : { kind: 'renew' };
  }
  return { kind: 'off' };
}

export type RiskBlock =
  { kind: 'paragraph'; text: string } | { kind: 'list'; items: { term: string | null; text: string }[] };

/** Paragraphs and the points of lists; a point "Term: text" keeps its term apart. */
export function riskBlocksOf(text: string): RiskBlock[] {
  const blocks: RiskBlock[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    if (trimmed.startsWith('- ')) {
      const point = trimmed.slice(2);
      const colon = point.indexOf(': ');
      const item =
        colon > 0
          ? { term: point.slice(0, colon), text: point.slice(colon + 2) }
          : { term: null, text: point };
      const last = blocks.at(-1);
      if (last?.kind === 'list') {
        last.items.push(item);
      } else {
        blocks.push({ kind: 'list', items: [item] });
      }
    } else {
      blocks.push({ kind: 'paragraph', text: trimmed });
    }
  }
  return blocks;
}
