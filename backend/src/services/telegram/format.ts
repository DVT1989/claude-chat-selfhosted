/**
 * Turn a stored assistant answer into Telegram messages (parse_mode HTML).
 * The web app keeps rendering the stored content itself; this only shapes what goes to Telegram.
 */

/** Telegram allows 4096 characters per message; split long plain text, preferring line breaks. */
export function splitMessage(text: string, max = 4000): string[] {
  if (!text.trim()) return ['(leeg antwoord)'];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= 0) {
      parts.push(rest.slice(0, max));
      rest = rest.slice(max);
    } else {
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1); // the newline itself is the separator
    }
  }
  parts.push(rest);
  return parts;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Inline markdown (bold, italic, code, links) on one line of text. */
function inline(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return `<code>${esc(part.slice(1, -1))}</code>`;
    return esc(part)
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u.replace(/"/g, '&quot;')}">${t}</a>`)
      .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
      .replace(/__([^_\n]+?)__/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<i>$2</i>')
      .replace(/(^|[^_\w])_([^_\n]+?)_(?![_\w])/g, '$1<i>$2</i>')
      .replace(/~~([^~\n]+?)~~/g, '<s>$1</s>');
  }).join('');
}

type Block = { kind: 'html'; html: string } | { kind: 'pre'; lang: string; code: string };

function markdownBlocks(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: 'html', html: para.join('\n') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push({ kind: 'pre', lang: fence[1], code: code.join('\n') });
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    const quote = /^>\s?(.*)$/.exec(line);
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flush(); blocks.push({ kind: 'html', html: '———' }); continue; }
    if (heading) para.push(`<b>${inline(heading[1])}</b>`);
    else if (bullet) para.push(`${bullet[1]}• ${inline(bullet[2])}`);
    else if (quote) para.push(`▎ <i>${inline(quote[1])}</i>`);
    else para.push(inline(line));
  }
  flush();
  return blocks;
}

function preHtml(lang: string, code: string): string {
  return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${esc(code)}</code></pre>`;
}

export function markdownToTelegramHtml(md: string): string {
  return markdownBlocks(md).map((b) => (b.kind === 'pre' ? preHtml(b.lang, b.code) : b.html)).join('\n\n');
}

interface StoredEvent { type?: string; text?: string; toolName?: string; toolInput?: Record<string, unknown> }

function toolLine(e: StoredEvent): string {
  const i = e.toolInput ?? {};
  const detail = [i.command, i.file_path, i.path, i.pattern, i.url, i.query, i.description, i.prompt]
    .find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const short = detail ? (detail.length > 200 ? detail.slice(0, 199) + '…' : detail).replace(/\s*\n\s*/g, ' ') : '';
  return `🔧 <i>${esc(e.toolName ?? 'tool')}</i>${short ? ` <code>${esc(short)}</code>` : ''}`;
}

/** Stored content (plain markdown, or the JSON event list of a tool-using run) → HTML blocks. */
function contentBlocks(content: string): Block[] {
  if (content.startsWith('[')) {
    try {
      const events = JSON.parse(content) as StoredEvent[];
      if (Array.isArray(events)) {
        const blocks: Block[] = [];
        let tools: string[] = [];
        const flushTools = () => { if (tools.length) blocks.push({ kind: 'html', html: tools.join('\n') }); tools = []; };
        for (const e of events) {
          if (e?.type === 'tool_use') tools.push(toolLine(e));
          else if (e?.type === 'text' && e.text?.trim()) { flushTools(); blocks.push(...markdownBlocks(e.text)); }
        }
        flushTools();
        return blocks;
      }
    } catch { /* not JSON after all: plain markdown */ }
  }
  return markdownBlocks(content);
}

/** Split one block so every piece fits; code blocks are split by lines and re-wrapped. */
function fitBlock(b: Block, max: number): string[] {
  if (b.kind === 'pre') {
    const whole = preHtml(b.lang, b.code);
    if (whole.length <= max) return [whole];
    const room = max - preHtml(b.lang, '').length;
    const pieces: string[] = [];
    let cur: string[] = [];
    let len = 0;
    for (const line of b.code.split('\n')) {
      const l = esc(line).length + 1;
      if (len + l > room && cur.length) { pieces.push(preHtml(b.lang, cur.join('\n'))); cur = []; len = 0; }
      cur.push(line.length > room ? line.slice(0, Math.floor(room / 6)) : line);
      len += l;
    }
    if (cur.length) pieces.push(preHtml(b.lang, cur.join('\n')));
    return pieces;
  }
  if (b.html.length <= max) return [b.html];
  return splitMessage(b.html, max); // lines of formatted text; tags never span lines
}

export function toTelegramChunks(content: string, max = 4000): string[] {
  const blocks = contentBlocks(content).flatMap((b) => fitBlock(b, max));
  if (!blocks.length) return ['(leeg antwoord)'];
  const chunks: string[] = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + 2 + b.length > max) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n\n${b}` : b;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Plain-text fallback when Telegram refuses the HTML. */
export function htmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
