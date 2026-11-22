'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

type Messages = Record<string, unknown>;

const I18nContext = createContext<Messages>({});

export function I18nProvider({ messages, children }: { messages: Messages; children: ReactNode }) {
  return <I18nContext.Provider value={messages}>{children}</I18nContext.Provider>;
}

function resolve(obj: unknown, path: string): string {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return path;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : path;
}

export function useTranslations(namespace: string) {
  const messages = useContext(I18nContext);
  return function t(key: string, params?: Record<string, string>): string {
    let value = resolve(messages, `${namespace}.${key}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
      }
    }
    return value;
  };
}
