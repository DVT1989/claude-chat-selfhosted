/** Round avatar with the conversation's initials on a colour derived from its id, like WhatsApp contacts. */
export function initials(title: string): string {
  const words = title.replace(/[^0-9A-Za-zÀ-ÖØ-öø-ÿ\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return (words[0][0] + (words[1]?.[0] ?? '')).toUpperCase();
}

export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % 360;
}

export default function ConvAvatar({ id, title, className = 'w-12 h-12 text-base' }: { id: string; title: string; className?: string }) {
  const hue = hueOf(id);
  return (
    <span
      aria-hidden
      className={`conv-avatar shrink-0 rounded-full flex items-center justify-center font-semibold select-none ${className}`}
      style={{ '--h': hue } as React.CSSProperties}
    >
      {initials(title)}
    </span>
  );
}
