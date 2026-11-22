'use client';

import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import Sidebar from '@/components/Sidebar';
import MobileTabBar from '@/components/MobileTabBar';
import PushSync from '@/components/PushSync';
import ViewportSync from '@/components/ViewportSync';
import LocaleSync from '@/components/LocaleSync';
import RestartWatcher from '@/components/RestartWatcher';

/**
 * Shared shell for Chats, Telegram and Settings (route group, URLs unchanged). The sidebar lives
 * here so it stays mounted when switching sections: no refetch of the user, list and usage and
 * no new event stream on every click. Phones get the tab bar instead of the rail.
 */
export default function MainLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '';
  const inChat = pathname === '/chat' || pathname.startsWith('/chat/');
  // Inside a conversation the composer owns the bottom of the screen (back arrow leads out)
  const tabBar = !pathname.startsWith('/chat/');
  return (
    <div className="flex h-full overflow-hidden bg-(--bg)">
      <Sidebar withList={inChat} />
      <div className={clsx('flex-1 min-w-0 flex flex-col overflow-hidden', tabBar && 'has-tabbar')}>
        {children}
      </div>
      {tabBar && <MobileTabBar />}
      <PushSync />
      <ViewportSync />
      <LocaleSync />
      <RestartWatcher />
    </div>
  );
}
