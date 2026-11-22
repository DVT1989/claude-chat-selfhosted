/**
 * One-line preview of a stored message for the conversation list (like WhatsApp's last-message line).
 * Assistant answers that used tools are stored as a JSON event array; we may only get the tail of that
 * string, so the last `"text":"…"` value is pulled out with a regex instead of JSON.parse.
 */
export function messagePreview(content: string | null | undefined, max = 120): string {
  if (!content) return '';
  let text = content;
  if (content.trimStart().startsWith('[') || content.includes('"type":"text"')) {
    const matches = [...content.matchAll(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g)];
    const last = matches.reverse().find((m) => m[1].trim());
    if (last) {
      try { text = JSON.parse(`"${last[1]}"`) as string; } catch { text = last[1]; }
    } else if (content.trimStart().startsWith('[')) {
      return '';
    }
  }
  const flat = text
    .replace(/```[\s\S]*?(```|$)/g, ' ')    // code blocks
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links / images
    .replace(/[*_`#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > max ? flat.slice(0, max - 1).trimEnd() + '…' : flat;
}
