'use client';

import { useAuthStore } from '@/lib/store';
import { useTranslations } from '@/lib/i18n';
import { NavIcons, settingsGroups, adminToolsItem, ADMIN_GROUP, type NavItem } from '@/components/navItems';

/**
 * The main navigation, shared by the desktop rail and the phone tab bar so both always show the
 * same buttons: Chats, then every settings section except Profiel (that is the avatar).
 */
export function useNav(): { top: NavItem[]; groups: NavItem[][]; phoneItems: NavItem[] } {
  const user = useAuthStore((s) => s.user);
  const t = useTranslations('settings.layout');
  const n = useTranslations('nav');
  const all = settingsGroups(
    { profile: t('profile'), claudeCode: t('claudeCode'), connectors: t('connectors'), users: t('users'), n },
    user?.role === 'admin',
  );
  const groups = all
    .map((g) => g.items.filter((i) => i.href !== '/settings/profiel'))
    .filter((items) => items.length > 0);
  const top: NavItem[] = [
    { href: '/chat', label: n('chats'), short: n('chats'), icon: NavIcons.chats, tint: '' },
  ];
  // Phones: same buttons, but the admin sections sit behind one "Admin tools" tab
  const admin = all.find((g) => g.title === ADMIN_GROUP)?.items ?? [];
  const rest = all.filter((g) => g.title !== ADMIN_GROUP).flatMap((g) => g.items).filter((i) => i.href !== '/settings/profiel');
  const phoneItems = [...top, ...rest, ...(admin.length ? [adminToolsItem(admin, n)] : [])];
  return { top, groups, phoneItems };
}
