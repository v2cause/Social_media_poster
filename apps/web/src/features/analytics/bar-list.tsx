import { cn } from '@smp/ui';
import type { ReactNode } from 'react';

import type { SeriesStyle } from './series-style';

// The bar chart of the analytics views (guide step 5.5): one row per group with its name, a bar
// relative to the largest value and the value as text. Every bar is named next to it, so the
// colors only repeat what the text says; a group without a value shows "n. v." and no bar.

export interface BarItem {
  key: string;
  label: ReactNode;
  value: number | null;
  style: SeriesStyle;
}

export function BarList(props: {
  title: string;
  items: readonly BarItem[];
  /** The value as text; null reads "n. v.". */
  formatValue: (value: number | null) => string;
}) {
  const max = Math.max(0, ...props.items.map((item) => item.value ?? 0));
  return (
    <ul aria-label={props.title} className="flex flex-col gap-3">
      {props.items.map((item) => {
        const share = item.value !== null && max > 0 ? Math.max(0, item.value) / max : 0;
        return (
          <li
            key={item.key}
            className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm"
          >
            <span className="flex min-w-0 items-center gap-2">{item.label}</span>
            <span aria-hidden="true" className="h-3 rounded-full bg-muted">
              <span
                className={cn('block h-3 rounded-full', item.style.fill, item.value === null && 'hidden')}
                style={{ width: `${String(Math.round(share * 1000) / 10)}%` }}
              />
            </span>
            <span className="tabular-nums">{props.formatValue(item.value)}</span>
          </li>
        );
      })}
    </ul>
  );
}
