'use client';

import { useEffect, useState } from 'react';
import clsx from 'clsx';

/**
 * Composer button (next to Send): show this conversation in the Chrome side panel of the Claude Chat Browser extension.
 * Only rendered when the extension answers: its page script (injected on the linked server address only)
 * replies to a ping via window.postMessage. Not Chrome, not linked or not installed means no reply, so no button.
 * Opening the panel needs a user gesture, hence the postMessage straight inside the click handler.
 */
export default function ChromePanelButton({ conversationId, className }: { conversationId: string; className?: string }) {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== window || e.origin !== window.location.origin || e.data?.source !== 'claude-ext') return;
      if (e.data.type === 'pong') setReady(true);
      if (e.data.type === 'panel-result') setErr(e.data.ok ? '' : String(e.data.error || 'Zijpaneel openen mislukt'));
    };
    window.addEventListener('message', onMsg);
    const ping = () => window.postMessage({ source: 'claude-page', type: 'ping' }, window.location.origin);
    ping();
    const timers = [setTimeout(ping, 400), setTimeout(ping, 1800)];
    return () => { window.removeEventListener('message', onMsg); timers.forEach(clearTimeout); };
  }, []);

  if (!ready) return null;
  const label = err || 'In Chrome-zijpaneel tonen';
  return (
    <button type="button" title={label} aria-label="Gesprek in Chrome-zijpaneel openen"
      onClick={() => { setErr(''); window.postMessage({ source: 'claude-page', type: 'open-panel', conversationId }, window.location.origin); }}
      className={clsx('hit-44 w-8 h-8 shrink-0 flex items-center justify-center rounded-full transition-[background-color,transform] duration-150 hover:bg-(--border) active:scale-95 motion-safe:animate-[ccPanelIn_.22s_ease-out]', err ? 'text-red-400' : 'text-(--muted)', className)}>
      <style>{'@keyframes ccPanelIn{from{opacity:0;transform:scale(.8)}to{opacity:1;transform:none}}'}</style>
      <svg className="w-[18px] h-[18px]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="4" width="18" height="16" rx="2.5" /><path d="M15 4v16" />
      </svg>
    </button>
  );
}
