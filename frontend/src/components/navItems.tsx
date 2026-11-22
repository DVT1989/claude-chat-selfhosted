import ClaudeLogo from '@/components/ClaudeLogo';

/** Line icons in one style (24px grid, 1.75 stroke, round caps), shared by the nav rail and the settings list.
 *  In the coloured tiles they render at exactly 24px with a 2px stroke (globals.css .rail-tile), so lines on the
 *  integer grid land on whole pixels (UI #8). Keep tile icons on integer coordinates. */
function Icon({ children, className = 'w-[22px] h-[22px]' }: { children: React.ReactNode; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export const NavIcons = {
  chats: (c?: string) => <Icon className={c}><path d="M7.5 19.8A9 9 0 1 0 4.2 16.5L3 21Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></Icon>,
  profile: (c?: string) => <Icon className={c}><circle cx="12" cy="8" r="4.5" /><path d="M20 21a8 8 0 0 0-16 0" /></Icon>,
  claude: (c?: string) => <ClaudeLogo className={c ?? 'w-[22px] h-[22px]'} />,
  /** White Claude mark for coloured tiles (the normal logo is orange) */
  claudeWhite: (c?: string) => <span className="claude-white inline-flex"><ClaudeLogo className={c ?? 'w-[22px] h-[22px]'} /></span>,
  connectors: (c?: string) => <Icon className={c}><path d="M12 22v-5" /><path d="M9 8V2M15 8V2" /><path d="M18 8v4a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5V8Z" /></Icon>,
  devices: (c?: string) => <Icon className={c}><rect x="2" y="3" width="20" height="14" rx="2" /><path d="M8 21h8M12 17v4" /></Icon>,
  m365: (c?: string) => <Icon className={c}><rect x="3" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5" /><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5" /><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5" /></Icon>,
  bot: (c?: string) => <Icon className={c}><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="3" /><path d="M2 14h2M20 14h2M15 13v2M9 13v2" /></Icon>,
  whatsapp: (c?: string) => <Icon className={c}><rect x="5" y="2" width="14" height="20" rx="3" /><path d="M12 18h.01" /></Icon>,
  skills: (c?: string) => <Icon className={c}><path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.13-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.13a.5.5 0 0 1 .96 0L14.06 8.5A2 2 0 0 0 15.5 9.94l6.13 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.13a.5.5 0 0 1-.96 0Z" /><path d="M20 3v4M22 5h-4" /></Icon>,
  /** light bulb: shared knowledge */
  knowledge: (c?: string) => <Icon className={c}><path d="M15 14c.2-1 .7-1.7 1.5-2.5A5.5 5.5 0 0 0 18 7.6 6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5" /><path d="M9 18h6M10 22h4" /></Icon>,
  /** brain: the user's own memory */
  memory: (c?: string) => <Icon className={c}><path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" /><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" /><path d="M12 5v13" /></Icon>,
  /** circular arrows with a spark: the learning loop */
  learn: (c?: string) => <Icon className={c}><path d="M20 11a8 8 0 1 0-2.3 5.7" /><path d="M20 4v7h-7" /><path d="M11 8.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8Z" /></Icon>,
  /** person with a spark: the user's own agents */
  agents: (c?: string) => <Icon className={c}><circle cx="10" cy="8" r="4" /><path d="M2.5 21a7.5 7.5 0 0 1 12.3-5.7" /><path d="M18.5 13.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" /></Icon>,
  terminal: (c?: string) => <Icon className={c}><rect x="2" y="4" width="20" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></Icon>,
  users: (c?: string) => <Icon className={c}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" /></Icon>,
  backups: (c?: string) => <Icon className={c}><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M3 5v14a9 3 0 0 0 18 0V5" /><path d="M3 12a9 3 0 0 0 18 0" /></Icon>,
  shield: (c?: string) => <Icon className={c}><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z" /><path d="m9 12 2 2 4-4" /></Icon>,
  logout: (c?: string) => <Icon className={c}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></Icon>,
  /** loose dots with a few links: the knowledge swarm */
  swarm: (c?: string) => <Icon className={c}><circle cx="6" cy="7" r="2.2" /><circle cx="17" cy="5.5" r="1.6" /><circle cx="15.5" cy="15.5" r="3" /><circle cx="5.5" cy="17.5" r="1.4" /><path d="M8 7.7 13 13M7 16.8l5.6-.9M16.6 7.1l-.6 5.4" /></Icon>,
  /** speech bubble with a spark: the assistant group (tasks, agents, skills) */
  assistant: (c?: string) => <Icon className={c}><path d="M7.5 19.8A9 9 0 1 0 4.2 16.5L3 21Z" /><path d="M12 8c.5 2 1.5 3 3.5 3.5-2 .5-3 1.5-3.5 3.5-.5-2-1.5-3-3.5-3.5 2-.5 3-1.5 3.5-3.5Z" /></Icon>,
  /** clock with a turning arrow: scheduled tasks */
  tasks: (c?: string) => <Icon className={c}><path d="M20.5 12a8.5 8.5 0 1 1-2.5-6" /><path d="M20.5 3.5V8H16" /><path d="M12 7.5V12l3 2" /></Icon>,
  plus: (c?: string) => <Icon className={c}><path d="M12 5v14M5 12h14" /></Icon>,
  search: (c?: string) => <Icon className={c}><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></Icon>,
};

/** tint: Tailwind class for the phone settings list; color: tile colour in the nav rail */
export type NavItem = {
  href: string; label: string; short: string; icon: (c?: string) => React.ReactNode; tint: string; color?: string;
  /** Sub-pages shown as tabs; the item counts as active on any of them */
  children?: NavItem[];
};

/** Active check that also covers an item's sub-pages */
export function isItemActive(pathname: string, item: NavItem): boolean {
  return isNavActive(pathname, item.href) || (item.children ?? []).some((c) => isNavActive(pathname, c.href));
}

const COLORS: Record<string, string> = {
  '/chat': 'var(--accent)',
  '/settings/profiel': '#71717a',
  '/settings/claude': '#D97757',
  '/settings/connectors': '#3b82f6',
  '/settings/m365': '#0369a1',
  '/settings/telegram': '#0ea5e9',
  '/settings/whatsapp': '#22c55e',
  '/settings/skills': '#8b5cf6',
  '/settings/taken': '#8b5cf6',
  '/settings/apparaten': '#6366f1',
  '/settings/agent': '#6366f1',
  '/settings/agents': '#a855f7',
  '/settings/swarm': '#ec4899',
  '/settings/geheugen': '#ec4899',
  '/settings/leerlus': '#ec4899',
  '/settings/adminprompt': '#475569',
  '/settings/admin': '#10b981',
  '/settings/backups': '#14b8a6',
  '/settings/kennis': '#f59e0b',
};
export function navColor(href: string): string {
  return COLORS[href] ?? 'var(--accent)';
}
export type NavGroup = { title: string; items: NavItem[] };

type Labels = { profile: string; claudeCode: string; connectors: string; users: string; n?: (key: string) => string };

/** The settings sections; the rail shows them as icons, the phone settings screen as an iOS list. */
export function settingsGroups(l: Labels, isAdmin: boolean): NavGroup[] {
  const n = l.n ?? ((k: string) => k);
  return [
    { title: 'Account', items: [
      { href: '/settings/profiel', label: l.profile, short: n('profile'), icon: NavIcons.profile, tint: 'bg-zinc-500' },
    ] },
    // One rail item; the four pages are tabs inside it (see SubTabs in settings/layout.tsx)
    { title: 'Koppelingen', items: [
      // opens on the first tab (Claude Code); keeps the blue plug as its own tile
      { href: '/settings/claude', label: n('connections'), short: n('connections'), icon: NavIcons.connectors, tint: 'bg-blue-500', color: '#3b82f6', children: [
        { href: '/settings/claude', label: l.claudeCode, short: n('claudeCode'), icon: NavIcons.claude, tint: 'bg-[#3a2a24]' },
        { href: '/settings/connectors', label: l.connectors, short: n('connectors'), icon: NavIcons.connectors, tint: 'bg-blue-500' },
        { href: '/settings/m365', label: n('m365'), short: n('m365'), icon: NavIcons.m365, tint: 'bg-sky-600' },
        { href: '/settings/telegram', label: n('telegram'), short: n('telegram'), icon: NavIcons.bot, tint: 'bg-sky-400' },
        { href: '/settings/whatsapp', label: n('whatsapp'), short: n('whatsapp'), icon: NavIcons.whatsapp, tint: 'bg-green-500' },
        { href: '/settings/agent', label: n('installAgent'), short: n('installAgent'), icon: NavIcons.devices, tint: 'bg-indigo-500' },
      ] },
    ] },
    { title: 'Uitbreidingen', items: [
      // Assistent as a group: Taken (opens first), Agents and Skills; the old addresses keep working
      { href: '/settings/taken', label: n('assistant'), short: n('assistant'), icon: NavIcons.assistant, tint: 'bg-violet-500', color: '#8b5cf6', children: [
        { href: '/settings/taken', label: n('tasks'), short: n('tasks'), icon: NavIcons.tasks, tint: 'bg-violet-500' },
        { href: '/settings/agents', label: n('agents'), short: n('agents'), icon: NavIcons.agents, tint: 'bg-purple-500' },
        { href: '/settings/skills', label: n('skills'), short: n('skills'), icon: NavIcons.skills, tint: 'bg-violet-500' },
      ] },
      // Geheugen with the learning loop as a second tab: what was learned, skill proposals, token budget
      // Geheugen as a group: Swarm (opens first), own memory, shared knowledge (admins only, as before), learning loop
      { href: '/settings/swarm', label: n('memory'), short: n('memory'), icon: NavIcons.memory, tint: 'bg-pink-500', color: '#ec4899', children: [
        { href: '/settings/swarm', label: n('swarm'), short: n('swarm'), icon: NavIcons.swarm, tint: 'bg-pink-500' },
        { href: '/settings/geheugen', label: n('memory'), short: n('memory'), icon: NavIcons.memory, tint: 'bg-pink-500' },
        ...(isAdmin ? [{ href: '/settings/kennis', label: n('sharedKnowledge'), short: n('sharedKnowledge'), icon: NavIcons.knowledge, tint: 'bg-amber-500' }] : []),
        { href: '/settings/leerlus', label: n('learningLoop'), short: n('learningLoop'), icon: NavIcons.learn, tint: 'bg-pink-500' },
      ] },
      { href: '/settings/apparaten', label: n('devices'), short: n('devices'), icon: NavIcons.devices, tint: 'bg-indigo-500' },
    ] },
    ...(isAdmin ? [{ title: ADMIN_GROUP, items: [
      { href: '/settings/adminprompt', label: n('adminChat'), short: n('adminShort'), icon: NavIcons.terminal, tint: 'bg-slate-600' },
      { href: '/settings/admin', label: l.users, short: n('users'), icon: NavIcons.users, tint: 'bg-emerald-500' },
      { href: '/settings/backups', label: n('backups'), short: n('backups'), icon: NavIcons.backups, tint: 'bg-teal-500' },
    ] }] : []),
  ];
}

export const ADMIN_GROUP = 'Beheer';

/** Phones: the admin sections behind one tab, opening the Admin tools overview. */
export function adminToolsItem(children: NavItem[], n: (key: string) => string = (k) => k): NavItem {
  return { href: '/settings/beheer', label: n('adminTools'), short: n('adminTools'), icon: NavIcons.shield, tint: 'bg-slate-600', color: '#64748b', children };
}

export function isNavActive(pathname: string, href: string): boolean {
  if (href === '/chat') return pathname === '/chat' || pathname.startsWith('/chat/');
  if (href === '/settings/profiel') return pathname === '/settings/profiel';
  return pathname === href || pathname.startsWith(href + '/');
}
