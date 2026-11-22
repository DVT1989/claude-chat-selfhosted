'use client';

/**
 * What Claude is doing right now, shown under the streaming answer while no text is arriving:
 * a small animation per kind of work plus a label (the tool's own description when there is one).
 */

type Kind = 'think' | 'terminal' | 'device' | 'read' | 'search' | 'write' | 'web' | 'agents' | 'plan' | 'cloud' | 'work';

export interface RunningTool { toolName: string; toolInput: unknown }

const base = (p: unknown) => (typeof p === 'string' ? p.split(/[\\/]/).pop() ?? p : '');

export function describe(tool: RunningTool | null): { kind: Kind; label: string } {
  if (!tool) return { kind: 'think', label: 'Denkt na' };
  const input = (tool.toolInput ?? {}) as Record<string, unknown>;
  const desc = typeof input.description === 'string' && input.description.trim() ? input.description.trim() : '';
  switch (tool.toolName) {
    case 'Bash': {
      const cmd = typeof input.command === 'string' ? input.command : '';
      if (/\/devices\/claude\//.test(cmd)) return { kind: 'device', label: desc || 'Werkt op apparaat' };
      if (/graph\.microsoft\.com/.test(cmd)) return { kind: 'cloud', label: desc || 'Microsoft 365 raadplegen' };
      if (/\bssh\b|\bscp\b|sshpass/.test(cmd)) return { kind: 'device', label: desc || 'Werkt op server' };
      if (/\bcurl\b|\bwget\b/.test(cmd) && !/127\.0\.0\.1|localhost/.test(cmd)) return { kind: 'web', label: desc || 'Gegevens ophalen' };
      return { kind: 'terminal', label: desc || 'Commando uitvoeren' };
    }
    case 'Read': return { kind: 'read', label: `Lezen: ${base(input.file_path)}` };
    case 'Grep': case 'Glob': case 'LS': return { kind: 'search', label: typeof input.pattern === 'string' ? `Zoeken: ${input.pattern.slice(0, 40)}` : 'Zoeken' };
    case 'Edit': case 'MultiEdit': case 'Write': case 'NotebookEdit': return { kind: 'write', label: `${tool.toolName === 'Write' ? 'Schrijven' : 'Bewerken'}: ${base(input.file_path ?? input.notebook_path)}` };
    case 'WebFetch': return { kind: 'web', label: typeof input.url === 'string' ? `Openen: ${input.url.replace(/^https?:\/\//, '').slice(0, 40)}` : 'Webpagina openen' };
    case 'WebSearch': return { kind: 'web', label: typeof input.query === 'string' ? `Zoeken op internet: ${input.query.slice(0, 40)}` : 'Zoeken op internet' };
    case 'Task': case 'Agent': return { kind: 'agents', label: desc || 'Hulpagent aan het werk' };
    case 'TodoWrite': return { kind: 'plan', label: 'Plan bijwerken' };
    default: return { kind: 'work', label: desc || tool.toolName };
  }
}

function Anim({ kind }: { kind: Kind }) {
  const c = 'ls-anim w-[18px] h-[18px] shrink-0 text-(--accent)';
  switch (kind) {
    case 'think':
      return <span className="flex gap-[3px] items-center h-[18px] shrink-0">{[0, 1, 2].map((i) => <span key={i} className="ls-dot" style={{ animationDelay: `${i * 160}ms` }} />)}</span>;
    case 'terminal':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="2.5" y="4" width="19" height="16" rx="3" strokeOpacity=".35" />
          <path d="M7 10l3 2-3 2" />
          <path className="ls-type ls-type-1" d="M12 14h1.5" /><path className="ls-type ls-type-2" d="M14.5 14h1.5" /><path className="ls-type ls-type-3" d="M17 14h0.5" />
        </svg>
      );
    case 'device':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="8" width="13" height="9" rx="1.5" /><path d="M7 21h5M9.5 17v4" />
          <path className="ls-wave ls-wave-1" d="M18 9.5a3 3 0 0 1 0 5" /><path className="ls-wave ls-wave-2" d="M20.5 7.5a6 6 0 0 1 0 9" />
        </svg>
      );
    case 'read':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 2.5h8l4 4v15H6z" strokeOpacity=".5" /><path d="M9 11h6M9 14h6M9 17h4" strokeOpacity=".35" />
          <path className="ls-scan" d="M7.5 8h9" />
        </svg>
      );
    case 'search':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <g className="ls-seek"><circle cx="10.5" cy="10.5" r="5" /><path d="M14.2 14.2L18 18" /></g>
        </svg>
      );
    case 'write':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path className="ls-draw" d="M3 20h12" />
          <g className="ls-pen"><path d="M14.5 4.5l3 3L9 16l-4 1 1-4z" /></g>
        </svg>
      );
    case 'web':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="9" /><path d="M3 12h18" strokeOpacity=".5" />
          <ellipse className="ls-globe" cx="12" cy="12" rx="4" ry="9" />
        </svg>
      );
    case 'cloud':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path d="M7 18a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.3 1.7A3.7 3.7 0 0 1 17 18z" strokeOpacity=".5" />
          <path className="ls-rise" d="M12 16v-5M10 13l2-2 2 2" />
        </svg>
      );
    case 'agents':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="currentColor">
          <circle cx="12" cy="12" r="2.6" />
          <g className="ls-orbit"><circle cx="12" cy="3.5" r="1.8" /><circle cx="19.4" cy="16.2" r="1.8" opacity=".7" /><circle cx="4.6" cy="16.2" r="1.8" opacity=".45" /></g>
        </svg>
      );
    case 'plan':
      return (
        <svg className={c} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <path className="ls-tick ls-tick-1" d="M3.5 7l1.5 1.5L8 5.5" /><path d="M11 7h9" strokeOpacity=".4" />
          <path className="ls-tick ls-tick-2" d="M3.5 14l1.5 1.5L8 12.5" /><path d="M11 14h9" strokeOpacity=".4" />
          <path d="M11 20h6" strokeOpacity=".25" />
        </svg>
      );
    default:
      return (
        <svg className={`${c} ls-spin`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
          <circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
        </svg>
      );
  }
}

export default function LiveStatus({ tool }: { tool: RunningTool | null }) {
  const { kind, label } = describe(tool);
  return (
    <div className="flex justify-start px-4 md:px-6 py-1.5" aria-live="polite">
      <div key={`${kind}:${label}`} className="ls-in flex items-center gap-2 min-w-0 max-w-[92%] md:max-w-[80%] pl-1">
        <Anim kind={kind} />
        <span className="ls-shimmer text-[13px] truncate">{label}</span>
      </div>
    </div>
  );
}
