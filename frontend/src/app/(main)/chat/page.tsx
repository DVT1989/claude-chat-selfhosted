'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore, useChatStore } from '@/lib/store';
import { conversations as convApi } from '@/lib/api';
import ClaudeLogo from '@/components/ClaudeLogo';
import ConversationList from '@/components/ConversationList';

function greeting(hour: number): string {
  if (hour < 6) return 'Goedenacht';
  if (hour < 12) return 'Goedemorgen';
  if (hour < 18) return 'Goedemiddag';
  return 'Goedenavond';
}

/** Phones: the conversation list (like WhatsApp). Desktop: the list is in the pane, so a greeting here. */
export default function ChatIndexPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const { conversations, addConversation } = useChatStore();
  const [hello, setHello] = useState('Welkom');
  const [busy, setBusy] = useState(false);

  // computed on the client so the greeting follows the viewer's clock
  useEffect(() => { setHello(greeting(new Date().getHours())); }, []);

  async function start() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await convApi.create({ title: 'Nieuw gesprek' });
      addConversation(res.conversation);
      router.push(`/chat/${res.conversation.id}`);
    } finally {
      setBusy(false);
    }
  }

  const firstName = user?.name?.split(' ')[0];
  const recent = conversations.slice(0, 4);

  return (
    <>
      <div className="md:hidden h-full">
        <ConversationList variant="page" />
      </div>

      <div className="hidden md:block h-full overflow-y-auto">
        <div className="min-h-full flex flex-col items-center justify-center px-4 py-12">
          <div className="w-full max-w-xl">
            <h1 className="flex items-center justify-center gap-3 text-3xl md:text-4xl font-semibold tracking-tight text-(--text) text-center text-balance">
              <ClaudeLogo className="w-9 h-9 md:w-10 md:h-10 shrink-0" />
              <span>{hello}{firstName ? `, ${firstName}` : ''}</span>
            </h1>

            <button
              onClick={() => void start()}
              disabled={busy}
              className="mt-8 w-full flex items-center gap-3 rounded-card border border-(--border) bg-(--input) px-5 py-4 text-left
                         text-(--muted) shadow-sm transition-[transform,border-color] duration-150 ease-out
                         hover:border-(--accent)/60 active:scale-[0.99] disabled:opacity-60"
            >
              <span className="flex-1">Waarmee kan ik helpen?</span>
              <span className="w-8 h-8 rounded-full bg-(--accent-strong) text-white flex items-center justify-center shrink-0">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M12 19V5m0 0l-6 6m6-6l6 6" />
                </svg>
              </span>
            </button>

            {recent.length > 0 && (
              <div className="mt-10">
                <p className="text-xs font-medium text-(--muted) mb-2 px-1">Recente gesprekken</p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {recent.map((c) => (
                    <Link
                      key={c.id}
                      href={`/chat/${c.id}`}
                      className="rounded-xl border border-(--border) px-4 py-3 text-sm text-(--text) truncate
                                 transition-colors duration-150 hover:bg-(--input)"
                    >
                      {c.title}
                    </Link>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
