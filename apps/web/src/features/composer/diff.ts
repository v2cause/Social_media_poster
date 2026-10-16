// A word diff for the refine dialog (guide step 2.8): what the AI removed and added. Whitespace
// counts as its own token, so line breaks survive. Very long texts (Facebook allows 63206
// characters) skip the quadratic comparison and show the whole text as replaced.

export interface DiffPart {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

/** Above this many token pairs, the diff shows the texts as replaced. */
const MAX_CELLS = 1_000_000;

const tokensOf = (text: string): string[] => text.match(/\s+|[^\s]+/g) ?? [];

function push(parts: DiffPart[], kind: DiffPart['kind'], text: string): void {
  const last = parts.at(-1);
  if (last?.kind === kind) {
    last.text += text;
  } else if (text.length > 0) {
    parts.push({ kind, text });
  }
}

export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokensOf(before);
  const b = tokensOf(after);
  if (a.length * b.length > MAX_CELLS) {
    const parts: DiffPart[] = [];
    push(parts, 'removed', before);
    push(parts, 'added', after);
    return parts;
  }

  // lengths[i][j]: the longest common subsequence of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lengths[i] as Uint32Array;
    const next = lengths[i + 1] as Uint32Array;
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(parts, 'same', a[i] ?? '');
      i += 1;
      j += 1;
    } else if ((lengths[i + 1]?.[j] ?? 0) >= (lengths[i]?.[j + 1] ?? 0)) {
      push(parts, 'removed', a[i] ?? '');
      i += 1;
    } else {
      push(parts, 'added', b[j] ?? '');
      j += 1;
    }
  }
  push(parts, 'removed', a.slice(i).join(''));
  push(parts, 'added', b.slice(j).join(''));
  return parts;
}
