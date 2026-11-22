'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/store';
import { NavIcons, navColor } from '@/components/navItems';

const TOOLS = [
  { href: '/settings/adminprompt', title: 'Admin-chat', text: 'Laat Claude de app en de containers op de NAS aanpassen.', icon: NavIcons.terminal },
  { href: '/settings/admin', title: 'Gebruikers', text: 'Accounts aanmaken, rollen wijzigen, sessies bekijken.', icon: NavIcons.users },
  { href: '/settings/backups', title: 'Backups', text: 'Dagelijkse back-ups bekijken, maken, downloaden of terugzetten.', icon: NavIcons.backups },
];

/** Phones: the admin sections behind the "Admin tools" tab (on desktop they are in the rail). */
export default function AdminToolsPage() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  useEffect(() => { if (user && user.role !== 'admin') router.replace('/settings'); }, [user, router]);
  if (!user || user.role !== 'admin') return null;

  return (
    <div className="w-full">
      <h1 className="text-xl font-semibold text-(--text) mb-5">Admin tools</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {TOOLS.map((t, i) => (
          <Link key={t.href} href={t.href} className="admin-card wa-row-in" style={{ '--i': i, '--c': navColor(t.href) } as React.CSSProperties}>
            <span className="rail-tile shrink-0">{t.icon('w-6 h-6')}</span>
            <span className="flex-1 min-w-0">
              <span className="block text-[15px] font-semibold text-(--text)">{t.title}</span>
              <span className="block text-[13px] text-(--muted) mt-0.5 leading-snug">{t.text}</span>
            </span>
            <svg className="w-4 h-4 text-(--muted) shrink-0 admin-card-chev" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
            </svg>
          </Link>
        ))}
      </div>
    </div>
  );
}
