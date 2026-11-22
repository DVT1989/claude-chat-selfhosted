'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import enMessages from '../../messages/en.json';
import nlMessages from '../../messages/nl.json';

type Messages = Record<string, unknown>;
const BUNDLED: Record<string, Messages> = { en: enMessages, nl: nlMessages };

interface I18nValue { locale: string; messages: Messages; setLocale: (code: string) => Promise<void> }
const I18nContext = createContext<I18nValue>({ locale: 'en', messages: enMessages, setLocale: async () => {} });

/** Server passes the locale and, for a generated language, its messages (otherwise the bundled en/nl are used). */
export function I18nProvider({ locale: initial, extra, children }: { locale: string; extra?: Messages | null; children: ReactNode }) {
  const [locale, setLoc] = useState(initial);
  const [cache, setCache] = useState<Record<string, Messages>>(() => (extra && !BUNDLED[initial] ? { [initial]: extra } : {}));

  const setLocale = useCallback(async (code: string) => {
    let m = BUNDLED[code] ?? cache[code];
    if (!m) {
      try {
        const res = await fetch(`/api/i18n/messages/${encodeURIComponent(code)}`, { cache: 'no-store' });
        if (res.ok) m = await res.json();
      } catch { /* fall back to English below */ }
      if (m) setCache((c) => ({ ...c, [code]: m as Messages }));
      else code = 'en';
    }
    document.cookie = `NEXT_LOCALE=${code}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = code;
    setLoc(code);
  }, [cache]);

  const value = useMemo<I18nValue>(() => ({ locale, messages: BUNDLED[locale] ?? cache[locale] ?? enMessages, setLocale }), [locale, cache, setLocale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function lookup(obj: unknown, parts: string[]): string | undefined {
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' ? cur : undefined;
}

export function useLocale() {
  const { locale, setLocale } = useContext(I18nContext);
  return { locale, setLocale };
}

export function useTranslations(namespace: string) {
  const { messages } = useContext(I18nContext);
  return function t(key: string, params?: Record<string, string | number>): string {
    const parts = `${namespace}.${key}`.split('.');
    // per key: chosen language, then English, then the key itself
    let value = lookup(messages, parts) ?? lookup(enMessages, parts) ?? `${namespace}.${key}`;
    if (params) {
      for (const [k, v] of Object.entries(params)) value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
  };
}
