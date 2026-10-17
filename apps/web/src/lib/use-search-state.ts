'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import type { z } from 'zod';

// State of a page in its query string (architecture 11): a link, a reload or a return to the page
// brings the same view back. Changes replace the entry of the history instead of adding one per
// click. The query is client input, so a zod schema reads it; each field falls back to its
// default when it is missing or invalid. Empty values leave the query string.

export function useSearchState<T extends Record<string, string>>(
  schema: z.ZodType<T>,
): [T, (patch: Partial<T>) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const state = useMemo(() => schema.parse(Object.fromEntries(params.entries())), [params, schema]);
  const update = useCallback(
    (patch: Partial<T>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(patch) as [string, string | undefined][]) {
        if (value === undefined || value === '') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      const query = next.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [params, pathname, router],
  );
  return [state, update];
}
