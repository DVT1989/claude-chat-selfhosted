import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import { I18nProvider } from '@/lib/i18n';
import { cookies } from 'next/headers';
import SwRegister from '@/components/SwRegister';
import ThemeProvider from '@/components/ThemeProvider';
import AppSplash, { SPLASH_HEAD_SCRIPT, SPLASH_HIDE_SCRIPT } from '@/components/AppSplash';
import splashImages from '@/components/splashImages.json';
import './globals.css';

// Self-hosted via next/font: no external CDN dependency, works offline/on NAS
const geistSans = Geist({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-sans',
});
const geistMono = Geist_Mono({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-geist-mono',
});

export const metadata: Metadata = {
  title: 'Claude Code',
  description: 'Multi-user AI chat powered by Claude Code',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Claude Code',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
  colorScheme: 'light dark',
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0c0a12' },
    { media: '(prefers-color-scheme: light)', color: '#ece9f1' },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  const rawLocale = cookieStore.get('NEXT_LOCALE')?.value ?? 'en';
  let locale = /^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(rawLocale) ? rawLocale : 'en';
  let extra: Record<string, unknown> | null = null;
  if (locale !== 'en' && locale !== 'nl') {
    // generated language: lives in the backend database, no rebuild needed
    try {
      const r = await fetch(`http://backend:4000/i18n/messages/${locale}`, { cache: 'no-store' });
      if (r.ok) extra = await r.json(); else locale = 'en';
    } catch { locale = 'en'; }
  }

  return (
    <html lang={locale} data-theme="dark" className={`${geistSans.variable} ${geistMono.variable}`} suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('theme_mode')||'system';var a=localStorage.getItem('accent_color')||'#CC785C';var resolved;if(m==='system'){resolved=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}else{resolved=m;}document.documentElement.dataset.theme=resolved;document.documentElement.style.setProperty('--accent',a);}catch(e){}})();`,
          }}
        />
        <script dangerouslySetInnerHTML={{ __html: SPLASH_HEAD_SCRIPT }} />
        {splashImages.map((s) => <link key={s.href} rel="apple-touch-startup-image" media={s.media} href={s.href} />)}
        <link rel="manifest" href="/manifest.json" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon.png" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Claude Code" />
        <meta name="msapplication-TileColor" content="#CC785C" />
        <meta name="msapplication-TileImage" content="/icons/icon-144.png" />
      </head>
      <body className="h-full" style={{ backgroundColor: 'var(--bg)', color: 'var(--text)' }}>
        <I18nProvider locale={locale} extra={extra}>
          <ThemeProvider>
            {/* soft coloured orbs that drift and breathe slowly (html.bg-motion), behind everything */}
            <div className="bg-orbs" aria-hidden><i /><i /><i /><i /></div>
            <SwRegister />
            {children}
          </ThemeProvider>
        </I18nProvider>
        <AppSplash />
        <script dangerouslySetInnerHTML={{ __html: SPLASH_HIDE_SCRIPT }} />
      </body>
    </html>
  );
}
