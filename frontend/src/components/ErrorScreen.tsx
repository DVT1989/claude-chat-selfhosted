'use client';

import Link from 'next/link';

/**
 * Shared Dutch error / not-found screen in the glass style (UI #4). Used by error.tsx and
 * not-found.tsx in the root and in (main), and by global-error.tsx.
 */
export default function ErrorScreen({ code, title, text, onRetry, digest }: {
  code?: string; title: string; text: string; onRetry?: () => void; digest?: string;
}) {
  const retry = onRetry ?? (() => window.location.reload());
  return (
    <div role="alert" className="flex-1 min-h-full w-full flex items-center justify-center p-6">
      <div className="w-full max-w-[420px] text-center rounded-card border border-(--card-border) bg-(--card-bg) px-6 py-8"
        style={{ boxShadow: 'var(--card-shadow)', WebkitBackdropFilter: 'blur(20px) saturate(160%)', backdropFilter: 'blur(20px) saturate(160%)' }}>
        <div className="mx-auto mb-4 w-12 h-12 rounded-2xl flex items-center justify-center text-(--accent-text)"
          style={{ background: 'color-mix(in srgb, var(--accent) 14%, transparent)' }}>
          <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="9" /><path d="M12 8v4M12 16h.01" />
          </svg>
        </div>
        {code && <p className="text-xs font-medium tracking-wide text-(--muted) mb-1">{code}</p>}
        <h1 className="text-lg font-semibold text-(--text)">{title}</h1>
        <p className="mt-2 text-sm text-(--muted)">{text}</p>
        {digest && <p className="mt-2 text-xs text-(--muted) font-mono">Code: {digest}</p>}
        <div className="mt-6 flex flex-col-reverse sm:flex-row gap-2 justify-center">
          <Link href="/chat" className="inline-flex items-center justify-center h-11 px-5 rounded-control text-sm font-medium text-(--text) border border-(--card-border) hover:bg-[color-mix(in_srgb,var(--text)_6%,transparent)] transition-colors">
            Naar Chats
          </Link>
          <button type="button" onClick={retry} className="inline-flex items-center justify-center h-11 px-5 rounded-control text-sm font-medium text-white bg-(--accent-strong) hover:brightness-110 transition">
            Opnieuw proberen
          </button>
        </div>
      </div>
    </div>
  );
}
