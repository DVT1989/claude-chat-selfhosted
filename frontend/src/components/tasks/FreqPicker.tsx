'use client';

import clsx from 'clsx';

/** How often a task runs, as the picker sees it. 'custom' is a cron the picker cannot show as buttons. */
export type FreqKind = 'werkdag' | 'dagelijks' | 'wekelijks' | 'maandelijks' | 'uur' | 'eenmalig' | 'custom';
export interface Freq { kind: FreqKind; time: string; dow: number; dom: number; date: string; cron?: string; text?: string }

const DAYS: Array<[number, string]> = [[1, 'ma'], [2, 'di'], [3, 'wo'], [4, 'do'], [5, 'vr'], [6, 'za'], [0, 'zo']];
const DAY_FULL = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const KINDS: Array<[FreqKind, string]> = [
  ['werkdag', 'Elke werkdag'], ['dagelijks', 'Dagelijks'], ['wekelijks', 'Wekelijks'], ['maandelijks', 'Maandelijks'], ['uur', 'Elk uur'], ['eenmalig', 'Eenmalig'],
];

export const EMPTY_FREQ: Freq = { kind: 'werkdag', time: '08:00', dow: 1, dom: 1, date: '' };

/** A cron (or one-off moment) from the wizard or a task, as picker state. */
export function freqFrom(cron: string | null | undefined, runAt: string | null | undefined, text?: string): Freq | null {
  if (!cron && runAt) {
    const d = new Date(runAt);
    // local "YYYY-MM-DDTHH:mm" (from Claude) stays as it is; an ISO time with zone becomes local wall time
    const local = /T\d\d:\d\d$/.test(runAt) ? runAt : Number.isNaN(d.getTime()) ? '' :
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { ...EMPTY_FREQ, kind: 'eenmalig', date: local, time: local.slice(11, 16) || '08:00' };
  }
  if (!cron) return null;
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return null;
  const [mi, h, dom, mon, dow] = p;
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
  const time = num(mi) !== null && num(h) !== null ? `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` : '08:00';
  if (num(mi) !== null && h === '*' && dom === '*' && mon === '*' && dow === '*') return { ...EMPTY_FREQ, kind: 'uur', time: `00:${String(mi).padStart(2, '0')}` };
  if (num(mi) !== null && num(h) !== null && mon === '*') {
    if (dom === '*' && dow === '1-5') return { ...EMPTY_FREQ, kind: 'werkdag', time };
    if (dom === '*' && dow === '*') return { ...EMPTY_FREQ, kind: 'dagelijks', time };
    if (dom === '*' && num(dow) !== null) return { ...EMPTY_FREQ, kind: 'wekelijks', time, dow: Number(dow) % 7 };
    if (num(dom) !== null && dow === '*') return { ...EMPTY_FREQ, kind: 'maandelijks', time, dom: Number(dom) };
  }
  return { ...EMPTY_FREQ, kind: 'custom', cron, text: text || cron };
}

/** Picker state → what the API stores. */
export function freqTo(f: Freq): { cron: string | null; run_at: string | null; schedule_text: string } | null {
  const [hh, mm] = (f.time || '08:00').split(':').map((x) => Number(x) || 0);
  const at = `om ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  switch (f.kind) {
    case 'werkdag': return { cron: `${mm} ${hh} * * 1-5`, run_at: null, schedule_text: `Elke werkdag ${at}` };
    case 'dagelijks': return { cron: `${mm} ${hh} * * *`, run_at: null, schedule_text: `Dagelijks ${at}` };
    case 'wekelijks': return { cron: `${mm} ${hh} * * ${f.dow}`, run_at: null, schedule_text: `Elke ${DAY_FULL[f.dow]} ${at}` };
    case 'maandelijks': return { cron: `${mm} ${hh} ${f.dom} * *`, run_at: null, schedule_text: `Elke maand op de ${f.dom}e ${at}` };
    case 'uur': return { cron: `${mm} * * * *`, run_at: null, schedule_text: mm ? `Elk uur om :${String(mm).padStart(2, '0')}` : 'Elk uur' };
    case 'eenmalig': {
      if (!f.date) return null;
      const d = new Date(f.date);
      if (Number.isNaN(d.getTime())) return null;
      return { cron: null, run_at: d.toISOString(), schedule_text: `Eenmalig op ${d.toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` };
    }
    case 'custom': return f.cron ? { cron: f.cron, run_at: null, schedule_text: f.text || f.cron } : null;
  }
}

const chip = (on: boolean) => clsx('px-3 py-1.5 rounded-full text-sm border transition-all duration-200 active:scale-95',
  on ? 'border-(--accent) bg-(--accent)/15 text-(--text)' : 'border-(--border) text-(--muted) hover:text-(--text) hover:border-(--muted)');
const input = 'bg-(--input) border border-(--border) rounded-lg px-2.5 py-1.5 text-sm text-(--text) outline-none focus:border-(--accent) transition-colors';

/** Frequency as tap targets: the common rhythms plus a time (and day, date or day of the month). */
export default function FreqPicker({ value, onChange }: { value: Freq; onChange: (f: Freq) => void }) {
  const set = (p: Partial<Freq>) => onChange({ ...value, ...p });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {value.kind === 'custom' && <button type="button" className={chip(true)}>{value.text}</button>}
        {KINDS.map(([k, label]) => (
          <button key={k} type="button" onClick={() => set({ kind: k })} className={chip(value.kind === k)}>{label}</button>
        ))}
      </div>
      {/* the details for the chosen rhythm fold open */}
      <div key={value.kind} className="tw-fade flex flex-wrap items-center gap-3">
        {value.kind === 'wekelijks' && (
          <div className="flex gap-1">
            {DAYS.map(([d, l]) => (
              <button key={d} type="button" onClick={() => set({ dow: d })}
                className={clsx('w-9 h-9 rounded-full text-xs font-medium border transition-all duration-200 active:scale-95',
                  value.dow === d ? 'bg-(--accent-strong) border-(--accent) text-white' : 'border-(--border) text-(--muted) hover:text-(--text)')}>{l}</button>
            ))}
          </div>
        )}
        {value.kind === 'maandelijks' && (
          <label className="flex items-center gap-2 text-sm text-(--muted)">op de
            <select className={input} value={value.dom} onChange={(e) => set({ dom: Number(e.target.value) })}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}e</option>)}
            </select>
          </label>
        )}
        {value.kind === 'eenmalig' ? (
          <input type="datetime-local" className={input} value={value.date} onChange={(e) => set({ date: e.target.value })} />
        ) : value.kind === 'uur' ? (
          <label className="flex items-center gap-2 text-sm text-(--muted)">op minuut
            <select className={input} value={Number(value.time.split(':')[1]) || 0} onChange={(e) => set({ time: `00:${String(e.target.value).padStart(2, '0')}` })}>
              {[0, 5, 10, 15, 20, 30, 45].map((m) => <option key={m} value={m}>:{String(m).padStart(2, '0')}</option>)}
            </select>
          </label>
        ) : value.kind !== 'custom' && (
          <label className="flex items-center gap-2 text-sm text-(--muted)">om
            <input type="time" className={input} value={value.time} onChange={(e) => set({ time: e.target.value || '08:00' })} />
          </label>
        )}
      </div>
    </div>
  );
}
