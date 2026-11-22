'use client';

import { useAuthStore } from '@/lib/store';

const COLORS = ['#CC785C', '#4A9EFF', '#34C759', '#AF52DE', '#FF9500', '#FF2D55'];

function colorForEmail(email: string): string {
  let hash = 0;
  for (const ch of email) hash = ch.charCodeAt(0) + ((hash << 5) - hash);
  return COLORS[Math.abs(hash) % COLORS.length];
}

interface Props {
  size?: 'sm' | 'md' | 'lg';
  user?: { avatar: string | null; name: string | null; email: string } | null;
}

export default function UserAvatar({ size = 'sm', user: userProp }: Props) {
  const storeUser = useAuthStore((s) => s.user);
  const user = userProp ?? storeUser;

  const dim = size === 'lg' ? 'w-20 h-20 text-2xl' : size === 'md' ? 'w-9 h-9 text-xs' : 'w-7 h-7 text-[0.6rem]';
  const initial = (user?.name?.[0] ?? user?.email?.[0] ?? 'U').toUpperCase();
  const bg = colorForEmail(user?.email ?? 'default');

  if (user?.avatar) {
    return (
      <div className={`${dim} rounded-full shrink-0 overflow-hidden mt-0.5`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={user.avatar} alt="" className="w-full h-full object-cover" />
      </div>
    );
  }

  return (
    <div
      className={`${dim} rounded-full flex items-center justify-center shrink-0 font-bold mt-0.5 text-white`}
      style={{ backgroundColor: bg }}
    >
      {initial}
    </div>
  );
}

/** The user's photo or initial filling a rounded square: same shape as the tab bar tiles. */
export function AvatarTile({ className = 'w-10 h-10 rounded-[12px] text-sm' }: { className?: string }) {
  const user = useAuthStore((s) => s.user);
  const initial = (user?.name?.[0] ?? user?.email?.[0] ?? 'U').toUpperCase();
  if (user?.avatar) {
    return (
      <span className={`${className} block overflow-hidden shrink-0`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={user.avatar} alt="" className="w-full h-full object-cover" />
      </span>
    );
  }
  return (
    <span className={`${className} flex items-center justify-center shrink-0 font-bold text-white`}
      style={{ backgroundColor: colorForEmail(user?.email ?? 'default') }}>
      {initial}
    </span>
  );
}
