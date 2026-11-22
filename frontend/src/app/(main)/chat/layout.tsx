'use client';

import { usePathname } from 'next/navigation';
import { useChatStore } from '@/lib/store';
import ConvAvatar from '@/components/ConvAvatar';
import MobileTopBar from '@/components/MobileTopBar';
import PushBell from '@/components/chat/PushBell';

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const conversations = useChatStore((s) => s.conversations);
  // Phones: inside a conversation the bar shows a back arrow, its avatar and title (like WhatsApp).
  // On /chat itself the conversation list is the page and brings its own header.
  const convId = (usePathname() ?? '').split('/')[2];
  const conv = convId ? conversations.find((c) => c.id === convId) : undefined;

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {convId && (
        <MobileTopBar back={{ href: '/chat', label: 'Terug naar gesprekken' }} right={<PushBell conversationId={convId} />}>
          {conv && <ConvAvatar id={conv.id} title={conv.title} className="w-9 h-9 text-xs" />}
          <h1 className="truncate text-[16px] font-semibold text-(--text)">{conv?.title ?? 'Gesprek'}</h1>
        </MobileTopBar>
      )}
      {/* a conversation slides in from the right on phones and fades in on desktop */}
      <main key={convId ?? 'list'} className={convId ? 'flex-1 overflow-hidden min-h-0 chat-in' : 'flex-1 overflow-hidden min-h-0 page-in'}>
        {children}
      </main>
    </div>
  );
}
