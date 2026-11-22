/** Pure helpers of the agent glow (no React), so they can be tested on their own. */

export const HEX = /^#[0-9a-f]{6}$/i;

/** A valid hex colour, else the accent colour of the theme. */
export function glowColor(c?: string | null): string {
  return c && HEX.test(c.trim()) ? c.trim() : 'var(--accent)';
}

/** Remove duplicates (case-insensitive), keep the order of first appearance. */
export function uniqueOrdered(colors: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of colors) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

const pct = (n: number) => `${Math.round(n * 100) / 100}%`;

/** Gradient for the ring: 1 colour is flat, n>=2 divides the circle equally with soft transitions. */
export function glowGradient(colors: string[]): string {
  const n = colors.length;
  if (n === 0) return '';
  if (n === 1) return `linear-gradient(${colors[0]}, ${colors[0]})`;
  const s = 100 / n;
  const seam = `color-mix(in srgb, ${colors[n - 1]} 50%, ${colors[0]})`;
  const stops = colors.map((c, i) => `${c} ${pct((i + 0.5) * s - 0.3 * s)} ${pct((i + 0.5) * s + 0.3 * s)}`);
  return `conic-gradient(from var(--ag-a), ${seam} 0%, ${stops.join(', ')}, ${seam} 100%)`;
}
