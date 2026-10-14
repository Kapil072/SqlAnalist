'use client';
import { createContext, useContext } from 'react';
import { DEFAULT_SOURCE_ID, SourceInfo } from '@/lib/api';

export interface DashCtx {
  injectPrompt: (q: string) => void;
  setInjectPrompt: (fn: (q: string) => void) => void;
  /** Database the chat is currently asking about ("default" or a data source id) */
  sourceId: string;
  /** Details of the selected database (name, type) */
  source: SourceInfo | null;
  /** Example questions for the selected database */
  suggestions: string[];
}

export const DashContext = createContext<DashCtx>({
  injectPrompt: () => {},
  setInjectPrompt: () => {},
  sourceId: DEFAULT_SOURCE_ID,
  source: null,
  suggestions: [],
});

export function useDash() {
  return useContext(DashContext);
}
