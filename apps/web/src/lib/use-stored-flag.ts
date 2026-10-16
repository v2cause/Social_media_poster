'use client';

import { useCallback, useSyncExternalStore } from 'react';

// A boolean in localStorage, read without a flash: the server renders the default, the browser
// the stored value. Storage may be unavailable (private mode); the flag then keeps its default.

const listeners = new Set<() => void>();

function read(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

export function useStoredFlag(key: string): [boolean, (value: boolean) => void] {
  const subscribe = useCallback((listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const value = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => false,
  );
  const setValue = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(key, next ? '1' : '0');
      } catch {
        // Not remembered then.
      }
      listeners.forEach((listener) => {
        listener();
      });
    },
    [key],
  );
  return [value, setValue];
}
