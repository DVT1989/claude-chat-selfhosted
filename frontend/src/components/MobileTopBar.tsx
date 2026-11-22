'use client';

import Link from 'next/link';

/** Phone top bar: optional back arrow, the title (or a custom title node) and an optional action on the right. Clears the iOS status bar. */
export default function MobileTopBar({ title, back, right, children }: {
  title?: string;
  back?: { href: string; label: string };
  right?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="md:hidden mtopbar shrink-0 pt-safe-header">
      <div className="flex items-center h-14 pl-2 pr-3 gap-1">
        {back ? (
          <Link href={back.href} aria-label={back.label} className="w-10 h-10 shrink-0 flex items-center justify-center rounded-full text-(--accent) active:bg-(--input)">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
            </svg>
          </Link>
        ) : <span className="w-2 shrink-0" />}
        <div className="flex-1 min-w-0 flex items-center gap-2.5">
          {children ?? <h1 className="truncate text-[17px] font-semibold text-(--text)">{title}</h1>}
        </div>
        {right}
      </div>
    </header>
  );
}
