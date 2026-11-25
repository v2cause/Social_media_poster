'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Toaster } from 'sonner';

import { LocalModeProvider } from '@/lib/local-mode';

/** Client-side state: TanStack Query for API data, toasts for feedback (architecture 11). */
export function Providers({ children, localMode }: { children: ReactNode; localMode: boolean }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <LocalModeProvider value={localMode}>{children}</LocalModeProvider>
      <Toaster position="top-right" closeButton />
    </QueryClientProvider>
  );
}
