/**
 * Empty state in one style (UI #18), after the Geheugen one: dashed card, an icon in a soft accent circle,
 * a short title and text and, where it helps, one action.
 */
export default function EmptyState({ icon, title, text, action, className = '' }: {
  icon: React.ReactNode; title: string; text?: React.ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  className?: string;
}) {
  return (
    <div className={`tw-fade rounded-card border border-dashed border-(--border) px-6 py-10 text-center ${className}`}>
      <span className="mx-auto mb-3 w-11 h-11 rounded-full flex items-center justify-center text-(--accent-text)"
        style={{ background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }} aria-hidden>
        {icon}
      </span>
      <p className="text-sm font-medium text-(--text)">{title}</p>
      {text && <p className="mt-1 text-xs text-(--muted) max-w-[42ch] mx-auto">{text}</p>}
      {action && (
        <button type="button" onClick={action.onClick} disabled={action.disabled}
          className="mt-4 px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium hover:brightness-110 disabled:opacity-50 transition">
          {action.label}
        </button>
      )}
    </div>
  );
}
