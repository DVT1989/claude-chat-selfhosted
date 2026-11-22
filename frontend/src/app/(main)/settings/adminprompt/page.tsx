'use client';

import PushBell from '@/components/chat/PushBell';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import ChatWindow from '@/components/chat/ChatWindow';
import MobileTopBar from '@/components/MobileTopBar';
import type { Message } from '@/types';

/** The admin system conversation in the same chat window as any other conversation. */
export default function AdminPromptPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const [conv, setConv] = useState<{ id: string; messages: Message[] } | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user && user.role !== 'admin') router.replace('/settings');
  }, [user, router]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/admin/system/conversation', { credentials: 'include' });
        const data = await res.json() as { conversationId: string; messages: Message[]; error?: string };
        if (!res.ok) throw new Error(data.error ?? 'Laden mislukt');
        setConv({ id: data.conversationId, messages: data.messages ?? [] });
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, []);

  async function handleReset() {
    if (!confirm('Huidig admin chat geheugen wissen en nieuw gesprek starten?')) return;
    setResetting(true);
    setError('');
    try {
      const res = await fetch('/api/admin/system/conversation/reset', { method: 'POST', credentials: 'include' });
      const data = await res.json() as { conversationId: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Reset mislukt');
      setConv({ id: data.conversationId, messages: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setResetting(false);
    }
  }

  if (!user || user.role !== 'admin') return null;

  const resetBtn = (
    <button
      onClick={() => void handleReset()}
      disabled={resetting}
      className="text-xs text-(--muted) hover:text-red-400 px-2 py-1 rounded hover:bg-red-500/10 transition-colors disabled:opacity-40"
      title="Wis geheugen en start nieuw gesprek"
    >
      {resetting ? 'Resetten…' : 'Reset chat'}
    </button>
  );

  // Fills the settings pane (phones: viewport minus the tab bar; the top bar clears the status bar)
  return (
    <div className="-mx-4 md:-mx-10 -my-6 md:-my-8 h-[calc(var(--app-h,100dvh)-var(--tabbar-h))] md:h-dvh flex flex-col">
      <MobileTopBar title="Admin-chat" back={{ href: '/settings/beheer', label: 'Terug naar Admin tools' }} right={<>{conv && <PushBell conversationId={conv.id} />}{resetBtn}</>} />
      {error && <div className="mx-6 mt-3 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-2 text-red-400 text-xs">{error}</div>}
      {conv && (
        <div className="flex-1 min-h-0">
          <ChatWindow
            key={conv.id}
            conversationId={conv.id}
            initialMessages={conv.messages}
            titleOverride="Admin-chat"
            headerExtra={resetBtn}
          />
        </div>
      )}
    </div>
  );
}
