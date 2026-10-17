'use client';

import { useCallback, useState } from 'react';

/**
 * The width of an element in pixels, kept up to date while it changes; `fallback` until the
 * element is measured, for example on the server. The charts draw their SVG at this width, so
 * text keeps its size instead of scaling with a viewBox.
 */
export function useElementWidth(fallback: number): [(node: HTMLElement | null) => () => void, number] {
  const [width, setWidth] = useState(fallback);
  const ref = useCallback((node: HTMLElement | null) => {
    if (!node) {
      return () => undefined;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (entry) {
        setWidth(Math.floor(entry.contentRect.width));
      }
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);
  return [ref, width];
}
