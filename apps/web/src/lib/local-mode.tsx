'use client';

import { createContext, useContext, type ReactNode } from 'react';

// The single-user mode (ADR 0046): the app runs on the user's own machine without sign-in and
// without billing. The root layout reads LOCAL_MODE on the server and hands it down, so the shell
// can leave out what has no meaning there (signing out, the billing pages).

const LocalModeContext = createContext(false);

export function LocalModeProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <LocalModeContext.Provider value={value}>{children}</LocalModeContext.Provider>;
}

export const useLocalMode = (): boolean => useContext(LocalModeContext);
