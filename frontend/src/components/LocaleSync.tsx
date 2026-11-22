'use client';

import { useEffect } from 'react';
import { useAuthStore } from '@/lib/store';
import { useLocale } from '@/lib/i18n';

/** The user's saved language wins: switch live when it differs from the active one (login, other device). */
export default function LocaleSync() {
  const language = useAuthStore((s) => s.user?.language);
  const { locale, setLocale } = useLocale();
  useEffect(() => { if (language && language !== locale) void setLocale(language); }, [language]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
