'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { useTranslations } from '@/lib/i18n';
import { settingsGroups, isNavActive, type NavItem } from '@/components/navItems';
import { useAuthStore } from '@/lib/store';
import MobileTopBar from '@/components/MobileTopBar';
import { useNavIndicator } from '@/components/useNavIndicator';

/**
 * Settings pages. Navigation lives in the rail (desktop) and tab bar (phone), so there is no
 * separate settings list any more; /settings itself is Profiel. Grouped items (Koppelingen) get tabs.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((s) => s.user);
  const pathname = usePathname() ?? '';
  const t = useTranslations('settings.layout');

  const groups = settingsGroups(
    { profile: t('profile'), claudeCode: t('claudeCode'), connectors: t('connectors'), users: t('users') },
    user?.role === 'admin',
  );

  function isActiveItem(item: NavItem): boolean {
    if (item.href === '/settings/profiel' && pathname === '/settings') return true;
    return isNavActive(pathname, item.href) || (item.children ?? []).some((c) => isNavActive(pathname, c.href));
  }
  const current = groups.flatMap((g) => g.items).find((i) => isActiveItem(i));
  const currentChild = current?.children?.find((c) => isNavActive(pathname, c.href));
  // The admin chat brings its own header (title + Reset chat), so no second bar above it
  const ownHeader = pathname.startsWith('/settings/adminprompt');
  // Phones reach the admin sections through the "Admin tools" tab: back arrow to that overview
  const isAdminTools = pathname.startsWith('/settings/beheer');
  const isAdminSection = ['/settings/admin', '/settings/backups'].some((h) => isNavActive(pathname, h));
  // Desktop: a readable column of at most 880px; wide tables keep the full width (Swarm follows the other Geheugen tabs)
  const fullWidth = ['/settings/apparaten', '/settings/admin/logs'].some((h) => isNavActive(pathname, h));

  // the highlighted pill glides from tab to tab
  const { ref: tabsRef, box: tabBox } = useNavIndicator<HTMLElement>(pathname);

  // Phones: the tab strip scrolls sideways; keep the active tab in view
  useEffect(() => {
    document.querySelector('.sub-tab-on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname]);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
      {!ownHeader && (
        <MobileTopBar
          title={isAdminTools ? 'Admin tools' : (currentChild?.label ?? current?.label ?? t('title'))}
          back={isAdminSection ? { href: '/settings/beheer', label: 'Terug naar Admin tools' } : undefined}
        />
      )}

      <main className="flex-1 overflow-y-auto overflow-x-clip min-h-0">
        <div className={clsx(!ownHeader && 'settings-body', 'w-full px-4 md:px-10 py-6 md:py-8', !ownHeader && !fullWidth && 'md:max-w-[960px] md:mx-auto')}>
          {/* Sub-pages of a grouped item (Koppelingen): tabs, like a segmented control */}
          {current?.children && (
            <nav ref={tabsRef} aria-label={current.label} className="sub-tabs mb-6">
              {tabBox && (
                <span aria-hidden className={clsx('sub-tab-pill', tabBox.animate && 'is-anim')}
                  style={{ transform: `translate(${tabBox.x}px, ${tabBox.y}px)`, width: tabBox.w, height: tabBox.h }} />
              )}
              {current.children.map((c) => {
                const on = isNavActive(pathname, c.href);
                return (
                  <Link key={c.href} href={c.href} aria-current={on ? 'page' : undefined} className={clsx('sub-tab', on && 'sub-tab-on')}>
                    {c.icon('w-4 h-4')}
                    <span>{c.short}</span>
                  </Link>
                );
              })}
            </nav>
          )}
          {/* a real page change fades in; switching tabs inside a group (Koppelingen, Assistent, Geheugen) does not,
              the sliding tab pill is the transition there (key = the group, not the tab) */}
          <div key={current?.children ? current.href : pathname} className="page-in">{children}</div>
        </div>
      </main>
    </div>
  );
}
