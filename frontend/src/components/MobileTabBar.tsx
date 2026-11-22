'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import clsx from 'clsx';
import { NavIcons, isItemActive, isNavActive, navColor } from '@/components/navItems';
import { useNav } from '@/components/useNav';
import { AvatarTile } from '@/components/UserAvatar';
import { useNavIndicator } from '@/components/useNavIndicator';

/**
 * Phone navigation: the same buttons as the desktop rail as icon tiles in a bottom bar, ending with
 * the user's own avatar (Profiel, with Afmelden). With more tiles than fit (admins) the bar scrolls
 * sideways. Hidden inside a conversation, where the composer sits at the bottom, like WhatsApp.
 */
export default function MobileTabBar() {
  const pathname = usePathname() ?? '';
  const { phoneItems: items } = useNav();
  const profileOn = pathname === '/settings' || isNavActive(pathname, '/settings/profiel');
  // gliding pill above the active tile
  const { ref, box } = useNavIndicator<HTMLDivElement>(pathname);
  const activeItem = items.find((i) => isItemActive(pathname, i));
  const activeColor = activeItem ? (activeItem.color ?? navColor(activeItem.href)) : 'var(--accent)';

  return (
    <nav aria-label="Hoofdmenu" className="tabbar md:hidden">
      <div ref={ref} className="tabbar-scroll">
        {box && (
          <span aria-hidden className={clsx('tab-ind', box.animate && 'is-anim')}
            style={{ transform: `translateX(${box.x + box.w / 2 - 11}px)`, background: activeColor }} />
        )}
        {items.map((item) => {
          const on = isItemActive(pathname, item);
          const icon = item.icon === NavIcons.claude ? NavIcons.claudeWhite : item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-label={item.label}
              aria-current={on ? 'page' : undefined}
              className={clsx('tab-btn', on && 'tab-btn-on')}
              style={{ '--c': item.color ?? navColor(item.href) } as React.CSSProperties}
            >
              <span className="rail-tile">{icon('w-6 h-6')}</span>
            </Link>
          );
        })}
        <Link
          href="/settings/profiel"
          aria-label="Profiel en afmelden"
          aria-current={profileOn ? 'page' : undefined}
          className={clsx('tab-btn tab-btn-avatar', profileOn && 'tab-btn-on')}
          style={{ '--c': 'var(--accent)' } as React.CSSProperties}
        >
          <span className="rail-tile">
            <AvatarTile className="w-full h-full rounded-[inherit] text-[15px]" />
          </span>
        </Link>
      </div>
    </nav>
  );
}
