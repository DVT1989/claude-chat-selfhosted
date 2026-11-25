'use client';

import type { CSSProperties, ReactNode } from 'react';

export type M365Level = 'read' | 'write';

export const M365_LEVELS: Array<{ v: M365Level; label: string; full: string; icon: ReactNode }> = [
  { v: 'read', label: 'Lezen', full: 'Lezen', icon: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></> },
  { v: 'write', label: 'Lezen en schrijven', full: 'Lezen en schrijven', icon: <><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></> },
];

/** Two-step segment (Lezen | Lezen en schrijven); the thumb slides and takes the green (read) or amber (write) tone. */
export function M365LevelSeg({ value, onPick, label, iconsOnMobile = false, className = '' }:
  { value: M365Level; onPick: (l: M365Level) => void; label: string; iconsOnMobile?: boolean; className?: string }) {
  const idx = M365_LEVELS.findIndex((l) => l.v === value);
  return (
    <div className={`m3-seg ${className}`} data-seg="2" data-lvl={idx + 1} style={{ '--lvl': idx } as CSSProperties} role="radiogroup" aria-label={label}>
      <span className="m3-thumb" aria-hidden />
      {M365_LEVELS.map((l, i) => (
        <button key={l.v} type="button" role="radio" aria-checked={i === idx} aria-label={l.full} title={l.full} data-i={i + 1} className="m3-opt" onClick={() => onPick(l.v)}>
          {iconsOnMobile && <svg className="sm:hidden w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>{l.icon}</svg>}
          <span className={iconsOnMobile ? 'hidden sm:inline' : ''}>{l.label}</span>
        </button>
      ))}
    </div>
  );
}
