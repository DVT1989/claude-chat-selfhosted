'use client';

import { useEffect, useRef, useState } from 'react';
import { glowGradient, uniqueOrdered } from './agentGlowUtils';

const CROSS_MS = 800;     // old layer removed after the cross-fade
const END_MS = 1100;      // all done: fade-out (1000 ms) and gone

interface Layer { key: string; colors: string[]; on: boolean }

/**
 * Glow around one card (parent must be position: relative with the same border-radius, see .ag-glow in globals.css).
 * One layer per colour set, cross-fade when the set changes; no colours (card done) fades out.
 */
export function AgentGlow({ colors: raw }: { colors: string[] }) {
  const colors = uniqueOrdered(raw);
  const [layers, setLayers] = useState<Layer[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const key = colors.join('|');

  useEffect(() => {
    const t = timers.current;
    if (!key) {
      setLayers((ls) => ls.map((l) => ({ ...l, on: false })));
      const x = setTimeout(() => setLayers((ls) => ls.filter((l) => l.on)), END_MS);
      t.push(x);
      return () => clearTimeout(x);
    }
    let raf = 0;
    setLayers((ls) => {
      // same key still there (maybe fading out): reuse it, so the glow does not dip
      if (ls.some((l) => l.key === key)) return ls.map((l) => ({ ...l, on: l.key === key }));
      return [...ls.map((l) => ({ ...l, on: false })), { key, colors, on: false }].slice(-2);
    });
    // next frame: .aan, so the opacity transition runs from 0
    raf = requestAnimationFrame(() => { raf = requestAnimationFrame(() => setLayers((ls) => ls.map((l) => l.key === key ? { ...l, on: true } : l))); });
    const x = setTimeout(() => setLayers((ls) => ls.filter((l) => l.on)), CROSS_MS);
    return () => { cancelAnimationFrame(raf); clearTimeout(x); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (layers.length === 0) return null;
  return (
    <div className="ag-glow" aria-hidden>
      {layers.map((l) => (
        <div key={l.key} className={`ag-layer${l.on ? ' aan' : ''}${l.colors.length === 1 ? ' een' : ''}`}
          style={{ '--ag-grad': glowGradient(l.colors) } as React.CSSProperties}>
          <div className="ag-gloed"><div className="ag-ring" /></div>
          <div className="ag-ring" />
        </div>
      ))}
    </div>
  );
}
