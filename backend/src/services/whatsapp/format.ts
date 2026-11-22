/**
 * Turn a stored assistant answer into WhatsApp messages (plain text with WhatsApp markup:
 * *bold*, _italic_, ~strike~, `code`, ```block```).
 */
import { splitMessage } from '../telegram/format';

interface StoredEvent { type?: string; text?: string; toolName?: string; toolInput?: Record<string, unknown> }

/** Inline markdown on one line (outside code blocks). */
function inline(line: string): string {
  return line.split(/(`[^`\n]+`)/).map((part) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return part;
    return part
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => (t === u ? u : `${t} (${u})`))
      .replace(/\*\*([^*\n]+?)\*\*/g, '\u0000$1\u0000') // bold placeholder, so the italic rule skips it
      .replace(/__([^_\n]+?)__/g, '\u0000$1\u0000')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1_$2_')
      .replace(/~~([^~\n]+?)~~/g, '~$1~')
      .replace(/\u0000/g, '*');
  }).join('');
}

export function markdownToWhatsApp(md: string): string {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      out.push('```'); // WhatsApp has no language tag
      continue;
    }
    if (inCode) { out.push(line); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) out.push('———');
    else if (heading) out.push(`*${inline(heading[1]).replace(/\*/g, '')}*`);
    else if (bullet) out.push(`${bullet[1]}• ${inline(bullet[2])}`);
    else out.push(inline(line));
  }
  if (inCode) out.push('```');
  return out.join('\n');
}

function toolLine(e: StoredEvent): string {
  const i = e.toolInput ?? {};
  const detail = [i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.description, i.prompt]
    .find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const short = detail ? (detail.length > 200 ? detail.slice(0, 199) + '…' : detail).replace(/\s*\n\s*/g, ' ').replace(/`/g, "'") : '';
  return `> _${e.toolName ?? 'tool'}_${short ? ` \`${short}\`` : ''}`;
}

/** Stored content (plain markdown, or the JSON event list of a tool-using run) → WhatsApp text. */
export function contentToWhatsApp(content: string): string {
  if (content.startsWith('[')) {
    try {
      const events = JSON.parse(content) as StoredEvent[];
      if (Array.isArray(events)) {
        const parts: string[] = [];
        let tools: string[] = [];
        const flush = () => { if (tools.length) parts.push(tools.join('\n')); tools = []; };
        for (const e of events) {
          if (e?.type === 'tool_use') tools.push(toolLine(e));
          else if (e?.type === 'text' && e.text?.trim()) { flush(); parts.push(markdownToWhatsApp(e.text.trim())); }
        }
        flush();
        return parts.join('\n\n');
      }
    } catch { /* plain markdown */ }
  }
  return markdownToWhatsApp(content);
}

/** Prefix on everything the bot sends, so its messages stand out in the self-chat. */
export const REPLY_PREFIX = '*Claude:*\n';

/** WhatsApp allows long messages, but chunks of ~4000 stay readable on a phone. */
export function toWhatsAppChunks(content: string, max = 4000 - REPLY_PREFIX.length): string[] {
  const text = contentToWhatsApp(content).trim();
  return text ? splitMessage(text, max) : ['(leeg antwoord)'];
}
