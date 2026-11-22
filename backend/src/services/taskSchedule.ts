/**
 * Cron helpers for scheduled tasks: the next run in a time zone (DST-safe) and a readable Dutch
 * description. Pure functions without imports, so they can be tested on their own.
 * Five-field cron: minute hour day-of-month month day-of-week (0 or 7 = Sunday).
 */

export interface CronFields { minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>; domAny: boolean; dowAny: boolean }

const DAY_NAMES = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const DOW_ALIAS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_ALIAS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseField(src: string, min: number, max: number, alias: Record<string, number> = {}): Set<number> | null {
  const out = new Set<number>();
  const num = (s: string): number => {
    const a = alias[s.toLowerCase()];
    if (a !== undefined) return a;
    if (!/^\d+$/.test(s)) return NaN;
    return Number(s);
  };
  for (const part of src.split(',')) {
    const m = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step >= 1)) return null;
    let lo: number, hi: number;
    if (m[1] === '*') { lo = min; hi = max; }
    else if (m[1].includes('-')) {
      const [a, b] = m[1].split('-');
      lo = num(a); hi = num(b);
    } else {
      lo = num(m[1]); hi = m[2] ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression; null when invalid. */
export function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0], 0, 59);
  const hour = parseField(parts[1], 0, 23);
  const dom = parseField(parts[2], 1, 31);
  const month = parseField(parts[3], 1, 12, MONTH_ALIAS);
  const dowRaw = parseField(parts[4], 0, 7, DOW_ALIAS);
  if (!minute || !hour || !dom || !month || !dowRaw) return null;
  const dow = new Set([...dowRaw].map((d) => (d === 7 ? 0 : d)));
  return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' };
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
/** Wall-clock parts of a moment in a time zone. */
export function localParts(d: Date, tz: string): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, dow: DOW_ALIAS[p.weekday.toLowerCase().slice(0, 3)] ?? 0 };
}

function dayMatches(c: CronFields, day: number, dow: number): boolean {
  // standard cron: when both day fields are restricted, either one may match
  if (!c.domAny && !c.dowAny) return c.dom.has(day) || c.dow.has(dow);
  if (!c.domAny) return c.dom.has(day);
  if (!c.dowAny) return c.dow.has(dow);
  return true;
}

/**
 * The first moment strictly after `after` that matches the cron expression in time zone `tz`.
 * Walks real (UTC) minutes and checks the wall clock, so DST gaps and repeats are handled; skips
 * whole hours and days when they cannot match. Null when nothing matches within ~2 years.
 */
export function nextRun(expr: string, tz: string, after: Date = new Date()): Date | null {
  const c = parseCron(expr);
  if (!c || !isValidTimezone(tz)) return null;
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = after.getTime() + 2 * 366 * 24 * 3600_000;
  for (let guard = 0; t < limit && guard < 200_000; guard++) {
    const p = localParts(new Date(t), tz);
    if (!c.month.has(p.month) || !dayMatches(c, p.day, p.dow)) {
      // to (just before) the next local midnight; one hour short for 23-hour DST days
      t += Math.max(1, (24 * 60 - (p.hour * 60 + p.minute)) - 60) * 60_000;
      continue;
    }
    if (!c.hour.has(p.hour)) { t += Math.max(1, 60 - p.minute) * 60_000; continue; }
    if (!c.minute.has(p.minute)) { t += 60_000; continue; }
    return new Date(t);
  }
  return null;
}

const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** Readable Dutch description of the common patterns; falls back to the expression itself. */
export function describeCron(expr: string): string {
  const c = parseCron(expr);
  if (!c) return expr;
  const parts = expr.trim().split(/\s+/);
  const single = (s: Set<number>) => (s.size === 1 ? [...s][0] : null);
  const m = single(c.minute), h = single(c.hour);
  const allMonths = parts[3] === '*';
  if (parts[1] === '*' && parts[2] === '*' && allMonths && parts[4] === '*') {
    if (m !== null) return m === 0 ? 'Elk uur' : `Elk uur om :${String(m).padStart(2, '0')}`;
    if (/^\*\/\d+$/.test(parts[0])) return `Elke ${parts[0].slice(2)} minuten`;
  }
  if (m === null || !allMonths) return expr;
  const at = h !== null ? `om ${hhmm(h, m)}` : `om ${[...c.hour].sort((a, b) => a - b).map((x) => hhmm(x, m)).join(', ')}`;
  if (c.domAny && c.dowAny) return `Dagelijks ${at}`;
  if (c.domAny && !c.dowAny) {
    const days = [...c.dow].sort((a, b) => a - b);
    if (days.join(',') === '1,2,3,4,5') return `Elke werkdag ${at}`;
    if (days.join(',') === '0,6') return `Elk weekend ${at}`;
    if (days.length === 1) return `Elke ${DAY_NAMES[days[0]]} ${at}`;
    return `Elke ${days.map((d) => DAY_NAMES[d]).join(', ')} ${at}`;
  }
  if (!c.domAny && c.dowAny && c.dom.size === 1) return `Elke maand op de ${[...c.dom][0]}e ${at}`;
  return expr;
}
