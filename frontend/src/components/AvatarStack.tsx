'use client';

import UserAvatar from '@/components/UserAvatar';
import type { ProjectMember } from '@/types';

/** Overlapping 20 px avatars of project members: max 3 plus "+N" (2 on a phone) */
export default function AvatarStack({ members, className }: { members: ProjectMember[]; className?: string }) {
  if (members.length < 2) return null;
  const shown = members.slice(0, 3);
  const extra = members.length - 3;
  return (
    <span className={`av-stack ${className ?? ''}`} aria-label={members.map((m) => m.name).join(', ')}>
      {shown.map((m, i) => (
        <span key={m.id} className={`av-stack-i ${i === 2 ? 'av-stack-3' : ''}`} style={{ zIndex: 5 - i }} title={m.name}>
          <UserAvatar size="sm" user={{ avatar: m.avatar, name: m.name, email: m.id }} />
        </span>
      ))}
      {extra > 0 && <span className="av-stack-more av-stack-3">+{extra}</span>}
      {extra >= 0 && <span className="av-stack-more av-stack-m">+{members.length - 2}</span>}
    </span>
  );
}
