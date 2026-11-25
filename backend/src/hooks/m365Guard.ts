/**
 * PreToolUse hook (Claude Code): keeps subagents without Microsoft 365 access away from the Graph token.
 * The main Claude of the owner writes the token to .m365-<alias>.token in the workspace; subagents run in the
 * same workspace and uid, so the file is readable for them. This hook looks at who is calling (agent_id /
 * agent_type in the hook input, absent for the main thread) and blocks Bash/Read/Grep/Glob calls that touch
 * the token files or graph.microsoft.com unless the subagent has access to that tenant (opt-in per agent).
 * Level "read": reading is fine, write markers (POST/PUT/PATCH/DELETE, GW, upload) are blocked.
 * Usage as hook: node m365Guard.js <base64 policy>; policy = { tenants: [{ alias, access: { slug: 'read'|'write' } }] }.
 */
export interface GuardPolicy { tenants: Array<{ alias: string; access: Record<string, 'read' | 'write'> }> }
export interface HookInput { tool_name?: string; tool_input?: Record<string, unknown>; agent_id?: string; agent_type?: string }

const GENERIC = /\.m365-|m365-[\w.-]*token|graph\.microsoft\.com|login\.microsoftonline\.com|\.m36\*|\.m\*|\.\*token|\*\.token|\.m365\b/i;
const WRITE = /-X\s*['"]?(POST|PUT|PATCH|DELETE)\b|--request\s*['"]?(POST|PUT|PATCH|DELETE)|\bGW\b|--data|--upload-file|\s-d\s|\s-T\s|sendMail|\/send\b/i;

/** The text of the tool input that can point at the token or Graph (not file contents that are only written). */
function targets(tool: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (tool) {
    case 'Bash': return s('command');
    case 'Read': case 'NotebookRead': return s('file_path') || s('notebook_path');
    case 'Grep': return [s('path'), s('glob')].join(' ');
    case 'Glob': return [s('pattern'), s('path')].join(' ');
    case 'WebFetch': return s('url');
    default: return '';
  }
}

/** Returns a reason when the call must be blocked, otherwise null. */
export function decide(input: HookInput, policy: GuardPolicy): string | null {
  const caller = input.agent_type || input.agent_id;
  if (!caller) return null; // main thread of the run: keeps its access
  if (!policy.tenants.length) return null;
  const text = targets(String(input.tool_name ?? ''), input.tool_input ?? {});
  if (!text || !GENERIC.test(text)) return null;
  const slug = input.agent_type ?? '';
  const named = policy.tenants.filter((t) => text.includes(`.m365-${t.alias}`) || text.includes(`m365-${t.alias}.token`));
  const needed = named.length ? named : policy.tenants; // generic (glob or Graph URL): access to every tenant required
  const lacking = needed.filter((t) => !t.access[slug]);
  if (lacking.length) {
    return `Geen toegang tot Microsoft 365 voor deze agent (${slug || 'onbekend'}). De gebruiker moet dit aanzetten onder Instellingen > Microsoft 365 > Rechten per agent. Probeer het token niet op een andere manier te gebruiken.`;
  }
  if (needed.some((t) => t.access[slug] === 'read') && WRITE.test(text)) {
    return `Deze agent (${slug}) heeft alleen Lezen voor Microsoft 365: geen schrijfacties (versturen, wijzigen, verwijderen, uploaden).`;
  }
  return null;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => {
    let reason: string | null = null;
    let input: HookInput | null = null;
    try { input = JSON.parse(raw) as HookInput; } catch { /* unreadable input: cannot tell who calls, let it pass */ }
    if (input) {
      try {
        const policy = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64').toString('utf8')) as GuardPolicy;
        reason = decide(input, policy);
      } catch (err) {
        // broken policy: closed for subagents, the main thread keeps working
        if (input.agent_type || input.agent_id) reason = `Microsoft 365-bewaking kon de aanroep niet controleren: ${(err as Error).message}`;
      }
    }
    if (reason) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
    }
    process.exit(0);
  });
}
