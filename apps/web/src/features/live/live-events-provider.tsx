'use client';

import { LIVE_EVENT_TYPES } from '@smp/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { parseLiveEvent, queryKeysAfterReconnect, queryKeysOf } from './live-events';

// One stream of live events per tab, for the workspace that is open (guide step 4.10). The
// browser opens a lost stream again by itself; while there is none, the views poll.

const LiveEventsContext = createContext<{ connected: boolean }>({ connected: false });

/** Whether the live events of the workspace arrive; views poll while they do not. */
export const useLiveEvents = (): { connected: boolean } => useContext(LiveEventsContext);

export function LiveEventsProvider({ slug, children }: { slug: string | null; children: ReactNode }) {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!slug || typeof EventSource === 'undefined') {
      return;
    }
    const source = new EventSource(`/api/w/${encodeURIComponent(slug)}/events`);
    let opened = false;
    const invalidate = (keys: readonly (readonly unknown[])[]) => {
      for (const queryKey of keys) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    source.onopen = () => {
      // Events of the time without a stream are lost: everything they could change is stale.
      if (opened) {
        invalidate(queryKeysAfterReconnect(slug));
      }
      opened = true;
      setConnected(true);
    };
    source.onerror = () => {
      setConnected(false);
    };
    const onEvent = (message: MessageEvent<string>) => {
      const event = parseLiveEvent(message.data);
      if (event) {
        invalidate(queryKeysOf(event, slug));
      }
    };
    for (const type of LIVE_EVENT_TYPES) {
      source.addEventListener(type, onEvent);
    }
    return () => {
      source.close();
      setConnected(false);
    };
  }, [slug, queryClient]);

  return <LiveEventsContext.Provider value={{ connected }}>{children}</LiveEventsContext.Provider>;
}
