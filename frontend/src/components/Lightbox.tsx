'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from '@/lib/i18n';

/** Image that opens large over the screen on click (Esc, click outside or the close button closes it). */
export default function ZoomImage({ src, alt, className }: { src: string; alt?: string; className?: string }) {
  const t = useTranslations('chat');
  const [mounted, setMounted] = useState(false);
  const [shown, setShown] = useState(false);

  function open() {
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
  }
  function close() {
    setShown(false);
    setTimeout(() => setMounted(false), 200);
  }

  useEffect(() => {
    if (!mounted) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey, true); document.body.style.overflow = prev; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted]);

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt ?? ''} loading="lazy" className={`${className ?? ''} cursor-zoom-in`} onClick={open} />
      {mounted && createPortal(
        <div className={`lb-root${shown ? ' lb-on' : ''}`} role="dialog" aria-modal="true" aria-label={alt || t('imageView')} onClick={close}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt ?? ''} className="lb-img" onClick={(e) => e.stopPropagation()} />
          <button type="button" className="lb-close" onClick={(e) => { e.stopPropagation(); close(); }} aria-label={t('closeImage')} title={t('closeImage')} autoFocus>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}
