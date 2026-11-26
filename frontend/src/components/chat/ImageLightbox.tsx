'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from '@/lib/i18n';

const EASE_OUT = 'cubic-bezier(0.23, 1, 0.32, 1)';
const EASE_DRAWER = 'cubic-bezier(0.32, 0.72, 0, 1)';

const reduced = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function flipTransform(first: DOMRect, last: DOMRect) {
  const sx = first.width / last.width;
  const sy = first.height / last.height;
  return `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${sx}, ${sy})`;
}

/** Thumbnail in a chat message; a plain click opens the lightbox, ctrl/cmd/middle click keeps the original link. */
export function LightboxThumb({ src, alt }: { src: string; alt: string }) {
  const [open, setOpen] = useState(false);
  const linkRef = useRef<HTMLAnchorElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  return (
    <>
      <a
        ref={linkRef}
        href={src}
        target="_blank"
        rel="noreferrer"
        onClick={e => {
          if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          setOpen(true);
        }}
        className="inline-block my-1.5 mr-2 align-top not-prose cursor-zoom-in"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          title={alt}
          loading="lazy"
          style={open ? { visibility: 'hidden' } : undefined}
          className="block max-h-[480px] max-w-full w-auto rounded-xl border border-(--border) object-contain object-top hover:brightness-105 transition"
        />
      </a>
      {open && (
        <ImageLightbox
          src={src}
          alt={alt}
          thumb={imgRef.current}
          onClosed={() => {
            setOpen(false);
            linkRef.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

function ImageLightbox({ src, alt, thumb, onClosed }: { src: string; alt: string; thumb: HTMLImageElement | null; onClosed: () => void }) {
  const tr = useTranslations('chat');
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  const [zoom, setZoom] = useState(false);
  const [light] = useState(() => document.documentElement.dataset.theme === 'light');
  const nat = useRef({
    w: thumb?.naturalWidth || thumb?.getBoundingClientRect().width || 1,
    h: thumb?.naturalHeight || thumb?.getBoundingClientRect().height || 1,
  });
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const firstRect = useRef<DOMRect | null>(null);
  const swiped = useRef(false);

  const mobile = vp.w < 640;
  const margin = mobile ? 16 : 24;
  const topPad = 72;
  const bottomPad = alt ? 56 : margin;
  const natW = nat.current.w;
  const natH = nat.current.h;
  const availW = Math.max(vp.w - margin * 2, 1);
  const availH = Math.max(vp.h - topPad - bottomPad, 1);
  const fit = Math.min(1, availW / natW, availH / natH);
  const fitW = natW * fit;
  const fitH = natH * fit;
  // actual size; a tall image is shown at viewport width and scrolls vertically
  const tall = natH / natW > vp.h / vp.w;
  const zoomW = tall ? Math.min(natW, vp.w) : natW;
  const zoomH = (natH / natW) * zoomW;
  const canZoom = zoomW > fitW * 1.02;

  useEffect(() => {
    const on = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  // keep natural size accurate once the image has loaded
  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
    if (w && (w !== nat.current.w || h !== nat.current.h)) {
      nat.current = { w, h };
      setVp(v => ({ ...v }));
    }
  };

  // open: FLIP from the thumbnail
  useLayoutEffect(() => {
    document.body.style.overflow = 'hidden';
    const img = imgRef.current;
    const scrim = scrimRef.current;
    if (!img || !scrim) return;
    if (reduced()) {
      scrim.animate({ opacity: [0, 1] }, { duration: 120 });
      img.animate({ opacity: [0, 1] }, { duration: 120 });
    } else {
      scrim.animate({ opacity: [0, 1] }, { duration: 240, easing: 'ease-out' });
      if (thumb) {
        const from = thumb.getBoundingClientRect();
        const to = img.getBoundingClientRect();
        if (from.width && to.width) {
          img.animate({ transform: [flipTransform(from, to), 'none'] }, { duration: 320, easing: EASE_OUT });
        }
      } else {
        img.animate({ opacity: [0, 1] }, { duration: 160 });
      }
    }
    const fade = { duration: 160, delay: 120, easing: 'ease-out', fill: 'backwards' as const };
    barRef.current?.animate({ opacity: [0, 1] }, fade);
    capRef.current?.animate({ opacity: [0, 1] }, fade);
    closeBtn.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // zoom switch: FLIP between fit and actual size
  useLayoutEffect(() => {
    const img = imgRef.current;
    const first = firstRect.current;
    firstRect.current = null;
    if (!img || !first) return;
    if (!zoom && stageRef.current) stageRef.current.scrollTop = 0;
    if (reduced()) return;
    const last = img.getBoundingClientRect();
    img.getAnimations().forEach(a => a.cancel());
    img.animate(
      { transform: [flipTransform(first, last), 'none'] },
      { duration: 220, easing: EASE_OUT },
    );
  }, [zoom]);

  const toggleZoom = () => {
    if (swiped.current) {
      swiped.current = false;
      return;
    }
    if (closing.current || !canZoom) return;
    firstRect.current = imgRef.current?.getBoundingClientRect() ?? null;
    setZoom(z => !z);
  };

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const img = imgRef.current;
    const scrim = scrimRef.current;
    if (!img || !scrim) return onClosed();
    const done = () => onClosed();
    const scrimNow = parseFloat(getComputedStyle(scrim).opacity) || 1;
    barRef.current && (barRef.current.style.opacity = '0');
    capRef.current && (capRef.current.style.opacity = '0');
    barRef.current?.getAnimations().forEach(a => a.cancel());
    capRef.current?.getAnimations().forEach(a => a.cancel());
    scrim.getAnimations().forEach(a => a.cancel());
    scrim.style.opacity = '0';
    if (reduced()) {
      scrim.animate({ opacity: [scrimNow, 0] }, { duration: 120 });
      img.animate({ opacity: [1, 0] }, { duration: 120, fill: 'forwards' }).onfinish = done;
      return;
    }
    scrim.animate({ opacity: [scrimNow, 0] }, { duration: 200, easing: 'ease-out' });
    const current = getComputedStyle(img).transform;
    img.getAnimations().forEach(a => a.cancel());
    img.style.transform = '';
    const t = thumb && thumb.isConnected ? thumb.getBoundingClientRect() : null;
    const visible = !!t && t.width > 0 && t.bottom > 0 && t.top < window.innerHeight && t.right > 0 && t.left < window.innerWidth;
    const from = current && current !== 'none' ? current : 'none';
    let anim: Animation;
    if (visible && !zoom) {
      const to = img.getBoundingClientRect();
      anim = img.animate({ transform: [from, flipTransform(t!, to)] }, { duration: 240, easing: EASE_DRAWER, fill: 'forwards' });
    } else {
      const base = from === 'none' ? '' : `${from} `;
      anim = img.animate(
        { transform: [from, `${base}scale(0.96)`], opacity: [1, 0] },
        { duration: 240, easing: EASE_DRAWER, fill: 'forwards' },
      );
    }
    anim.onfinish = done;
  }, [onClosed, thumb, zoom]);

  // Esc, focus trap
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        const items = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button, a[href]') ?? []);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (!dialogRef.current?.contains(active)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [close]);

  // swipe down to close (touch, fit mode only)
  const drag = useRef<{ y: number; x: number; t: number; dy: number; on: boolean } | null>(null);
  const onTouchStart = (e: React.TouchEvent) => {
    if (zoom || closing.current || e.touches.length !== 1) return (drag.current = null);
    drag.current = { y: e.touches[0].clientY, x: e.touches[0].clientX, t: performance.now(), dy: 0, on: false };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const d = drag.current;
    if (!d) return;
    if (e.touches.length !== 1) {
      drag.current = null;
      return;
    }
    const dy = e.touches[0].clientY - d.y;
    const dx = e.touches[0].clientX - d.x;
    if (!d.on && (dy < 8 || Math.abs(dx) > dy)) return;
    d.on = true;
    d.dy = Math.max(0, dy);
    if (imgRef.current) imgRef.current.style.transform = `translateY(${d.dy}px)`;
    if (scrimRef.current) scrimRef.current.style.opacity = String(Math.max(0, 1 - d.dy / 300));
  };
  const onTouchEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (!d || !d.on) return;
    swiped.current = true;
    setTimeout(() => (swiped.current = false), 350);
    const v = d.dy / Math.max(performance.now() - d.t, 1);
    if (d.dy > 80 || v > 0.5) return close();
    const img = imgRef.current;
    const scrim = scrimRef.current;
    if (img) {
      img.style.transform = '';
      if (!reduced()) img.animate({ transform: [`translateY(${d.dy}px)`, 'none'] }, { duration: 200, easing: EASE_OUT });
    }
    if (scrim) {
      scrim.animate({ opacity: [Math.max(0, 1 - d.dy / 300), 1] }, { duration: 200 });
      scrim.style.opacity = '';
    }
  };

  const filename = (() => {
    const base = alt && /\.(png|jpe?g|gif|webp|svg)$/i.test(alt) ? alt : '';
    return base || src.split('?')[0].split('/').filter(Boolean).slice(-2, -1)[0] || 'image';
  })();

  const btn =
    'w-11 h-11 sm:w-10 sm:h-10 rounded-full flex items-center justify-center text-white bg-black/55 border border-white/30 backdrop-blur-[8px] hover:bg-black/70 shadow-[0_2px_8px_rgba(0,0,0,.35)] active:scale-[.94] transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white';
  const icon = { className: 'w-5 h-5', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, viewBox: '0 0 24 24', 'aria-hidden': true };

  return createPortal(
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label={alt || 'Image'} className="fixed inset-0 z-[1000]">
      <div
        ref={scrimRef}
        onClick={close}
        className="absolute inset-0"
        style={{
          background: light ? 'rgba(24,20,31,.66)' : 'rgba(8,6,14,.78)',
          backdropFilter: 'blur(12px) saturate(1.1)',
          WebkitBackdropFilter: 'blur(12px) saturate(1.1)',
        }}
      />
      <div
        ref={stageRef}
        onClick={e => e.target === e.currentTarget && close()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        className="absolute inset-0 flex"
        style={{
          padding: zoom ? 0 : `${topPad}px ${margin}px ${bottomPad}px`,
          overflow: zoom ? 'auto' : 'hidden',
          overscrollBehavior: 'contain',
          touchAction: 'pan-x pan-y pinch-zoom',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          onLoad={onLoad}
          onClick={toggleZoom}
          style={{
            width: zoom ? zoomW : fitW,
            height: zoom ? zoomH : fitH,
            margin: 'auto',
            flex: 'none',
            maxWidth: 'none',
            borderRadius: zoom ? 0 : 12,
            boxShadow: '0 24px 80px -20px rgba(0,0,0,.6)',
            cursor: canZoom ? (zoom ? 'zoom-out' : 'zoom-in') : 'default',
            transformOrigin: '0 0',
            userSelect: 'none',
          }}
        />
      </div>
      <div ref={barRef} className="absolute top-4 right-4 flex gap-2">
        {canZoom && (
          <button type="button" className={btn} onClick={toggleZoom} aria-label={zoom ? tr('lightboxZoomOut') : tr('lightboxZoomIn')} aria-pressed={zoom}>
            <svg {...icon}>
              {zoom ? <path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7" /> : <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />}
            </svg>
          </button>
        )}
        <a href={src} download={filename} className={btn} aria-label={tr('lightboxDownload')}>
          <svg {...icon}><path d="M12 4v11M7 11l5 5 5-5M5 20h14" /></svg>
        </a>
        <a href={src} target="_blank" rel="noreferrer" className={btn} aria-label={tr('lightboxOpen')}>
          <svg {...icon}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></svg>
        </a>
        <button ref={closeBtn} type="button" className={btn} onClick={close} aria-label={tr('lightboxClose')}>
          <svg {...icon}><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </div>
      {alt && !zoom && (
        <div ref={capRef} className="pointer-events-none absolute inset-x-0 bottom-0 px-6 pb-4 text-center text-[13px] leading-snug" style={{ color: '#d6d1e0' }}>
          <span className="line-clamp-2">{alt}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}
