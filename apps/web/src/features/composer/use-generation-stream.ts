'use client';

import { useCallback, useEffect, useReducer, useRef } from 'react';

import { IDLE, postStream, streamReducer, type StreamState } from './generation-stream';

/**
 * One AI stream at a time. A new start or leaving the page aborts the running one, which also
 * aborts the call on the server (guide step 2.8).
 */
export function useGenerationStream(): {
  state: StreamState;
  start: (url: string, body: unknown) => Promise<StreamState>;
  cancel: () => void;
  reset: () => void;
} {
  const [state, dispatch] = useReducer(streamReducer, IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const start = useCallback(async (url: string, body: unknown): Promise<StreamState> => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    // The reducer also runs here, so the caller gets the final state without waiting for a render.
    let current = streamReducer(IDLE, { type: 'start' });
    dispatch({ type: 'start' });
    try {
      await postStream(url, body, controller.signal, (event) => {
        current = streamReducer(current, { type: 'event', event });
        dispatch({ type: 'event', event });
      });
    } catch (error) {
      if (controller.signal.aborted) {
        dispatch({ type: 'cancel' });
        return IDLE;
      }
      current = streamReducer(current, { type: 'error', error });
      dispatch({ type: 'error', error });
    }
    return current;
  }, []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: 'cancel' });
  }, []);

  return { state, start, cancel, reset };
}
