'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback } from 'react';

import { authClient } from '@/lib/auth-client';

/**
 * Signs out and leaves nothing of the account in the tab (guide step 8.4): the API asks the
 * browser to drop its cache and storage, and the cached queries go as well, so the next person
 * at this browser sees none of it.
 */
export function useSignOut(): (next?: string) => Promise<void> {
  const router = useRouter();
  const queryClient = useQueryClient();
  return useCallback(
    async (next = '/login') => {
      await authClient.signOut();
      queryClient.clear();
      router.push(next);
      router.refresh();
    },
    [queryClient, router],
  );
}
