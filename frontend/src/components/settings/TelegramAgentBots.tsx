'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AgentAvatar } from '@/components/chat/AgentBubble';
import { telegramBots, type AgentBot, type AgentBotOverview, type AgentBotChatter } from '@/lib/api';
import MessengerLink from '@/components/settings/MessengerLink';

const input = 'tg-input';
const primary = 'tg-btn p';
const secondary = 'tg-btn s';
const danger = 'tg-btn d';

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('nl-NL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** All Telegram bots in one list, each the same: agents optional, chatters, links and options under Geavanceerd. */
export default function TelegramAgentBots() {
  const [data, setData] = useState<AgentBotOverview | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setData(await telegramBots.list()); } catch (e) { setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // requests arrive while the page is open
  useEffect(() => {
    const t = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function act(fn: () => Promise<AgentBotOverview>): Promise<boolean> {
    setBusy(true); setError('');
    try { setData(await fn()); return true; }
    catch (e) { setError((e as Error).message); return false; }
    finally { setBusy(false); }
  }

  const pending = data?.bots.reduce((n, b) => n + b.chatters.filter((c) => c.status === 'pending').length, 0) ?? 0;

  return (
    <section aria-labelledby="tgbots-title">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h1 id="tgbots-title" className="text-xl font-semibold text-(--text) flex items-center gap-2">
          Telegram-bots
          {pending > 0 && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-(--accent-strong) text-white">{pending} aanvraag{pending === 1 ? '' : 'en'}</span>}
        </h1>
        {!adding && <button type="button" className={primary} onClick={() => setAdding(true)}>Bot toevoegen</button>}
      </div>
      <p className="text-xs text-(--muted) mb-4">
        Zonder agents praat je bot met Claude zelf, met agents met die agents. Jezelf koppel je met de koppellink; anderen komen binnen met een uitnodigingslink of na jouw goedkeuring.
        Elke chatter ziet alleen zijn eigen gesprekken; jij ziet in de bot al je gesprekken (of, met agents, de gesprekken met die agents).
        Een nieuwe bot maak je bij <a className="text-(--accent) underline" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> met <code>/newbot</code>; plak daarna de token.
      </p>

      {error && <div className="mb-3 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">{error}</div>}

      {adding && data && (
        <BotForm agents={data.agents} busy={busy} onCancel={() => setAdding(false)}
          onSave={async (v) => { if (await act(() => telegramBots.create(v))) setAdding(false); }} />
      )}

      <div className="space-y-3">
        {data?.bots.map((b, i) => (
          <BotCard key={b.id} bot={b} agents={data.agents} index={i} open={open === b.id} busy={busy}
            onToggle={() => setOpen(open === b.id ? null : b.id)} act={act} />
        ))}
        {data && !data.bots.length && !adding && (
          <p className="text-sm text-(--muted) bg-(--input) border border-(--border) rounded-card p-4">
            Nog geen bots. Kies &quot;Bot toevoegen&quot; en plak de token van @BotFather.
          </p>
        )}
      </div>
    </section>
  );
}

function AgentPicker({ agents, value, onChange }: { agents: AgentBotOverview['agents']; value: string[]; onChange: (v: string[]) => void }) {
  if (!agents.length) return <p className="tg-hint">Je hebt nog geen agents. Maak er een op de agents-pagina.</p>;
  return (
    <div className="tg-agent-grid">
      {agents.map((a) => {
        const on = value.includes(a.id);
        return (
          <button key={a.id} type="button" aria-pressed={on} className="tg-agent-tile"
            onClick={() => onChange(on ? value.filter((v) => v !== a.id) : [...value, a.id])}>
            <span className="tg-agent-av">
              <AgentAvatar name={a.name} avatar={a.avatar} color={a.color} className="w-11 h-11 text-sm" />
              <span className="tg-agent-check" aria-hidden>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
              </span>
            </span>
            <span className="tg-agent-name">{a.name}</span>
            {a.shared_by ? <small>van {a.shared_by}</small> : null}
          </button>
        );
      })}
    </div>
  );
}

function BotForm({ agents, busy, onSave, onCancel }: {
  agents: AgentBotOverview['agents']; busy: boolean; onCancel: () => void;
  onSave: (v: { name: string; botToken: string; agentIds: string[]; ratePerHour: number }) => void;
}) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [ids, setIds] = useState<string[]>([]);
  const [rate, setRate] = useState('20');
  return (
    <form className="user-edit bg-(--input) border border-(--border) rounded-card p-4 mb-3 space-y-3"
      onSubmit={(e) => { e.preventDefault(); onSave({ name: name.trim(), botToken: token.trim(), agentIds: ids, ratePerHour: Math.max(0, Number(rate) || 0) }); }}>
      <div>
        <label className="block text-xs text-(--muted) mb-1" htmlFor="tgb-name">Naam (zie je terug bij de gesprekken)</label>
        <input id="tgb-name" className={input} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="Bijvoorbeeld Studiobot" />
      </div>
      <div>
        <label className="block text-xs text-(--muted) mb-1" htmlFor="tgb-token">Bot-token van @BotFather</label>
        <input id="tgb-token" className={input} type="password" autoComplete="off" placeholder="123456789:AA..." value={token} onChange={(e) => setToken(e.target.value)} />
      </div>
      <div>
            <p className="text-xs text-(--muted) mb-1">Agents, optioneel (geen: Claude zelf antwoordt; een: die agent; meer: @naam of het team kiest)</p>
            <AgentPicker agents={agents} value={ids} onChange={setIds} />
      </div>
      <div>
        <label className="block text-xs text-(--muted) mb-1" htmlFor="tgb-rate">Berichten per uur per gast (0 = onbeperkt; jijzelf hebt geen limiet)</label>
        <input id="tgb-rate" className={input} style={{ width: 84, textAlign: 'right' }} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} />
      </div>
      <div className="tg-btns cols">
        <button type="submit" className={primary} disabled={busy || !token.trim() || !name.trim()}>Opslaan</button>
        <button type="button" className={secondary} onClick={onCancel}>Annuleren</button>
      </div>
    </form>
  );
}

const STATUS_LABEL: Record<string, string> = { ok: 'Actief', off: 'Uit', error: 'Fout' };

function initials(name: string): string {
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  return (w.length > 1 ? w[0][0] + w[w.length - 1][0] : w[0].slice(0, 2)).toUpperCase();
}

const sec = (n: number) => ({ ['--s' as string]: n });

function Chevron({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>;
}

function BotCard({ bot, agents, index, open, busy, onToggle, act }: {
  bot: AgentBot; agents: AgentBotOverview['agents']; index: number; open: boolean; busy: boolean;
  onToggle: () => void; act: (fn: () => Promise<AgentBotOverview>) => Promise<boolean>;
}) {
  const [ids, setIds] = useState(bot.agentIds);
  const [name, setName] = useState(bot.name);
  const [rate, setRate] = useState(String(bot.ratePerHour));
  const [token, setToken] = useState('');
  const [tokOpen, setTokOpen] = useState(false);
  const [adv, setAdv] = useState(false);
  const [restOpen, setRestOpen] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [own, setOwn] = useState<{ code: string; expiresAt: string; link: string | null } | null>(null);
  const [copied, setCopied] = useState('');
  const [err, setErr] = useState('');
  const pending = bot.chatters.filter((c) => c.status === 'pending');
  const approved = bot.chatters.filter((c) => c.status === 'approved');
  const rest = bot.chatters.filter((c) => c.status === 'denied' || c.status === 'revoked');
  const hasOwner = approved.some((c) => c.isOwner);
  const dirty = ids.slice().sort().join() !== bot.agentIds.slice().sort().join() || rate !== String(bot.ratePerHour) || name.trim() !== bot.name;
  const dotCls = bot.status === 'ok' ? '' : bot.status === 'error' ? 'is-err' : 'is-off';
  const agentNames = agents.filter((x) => bot.agentIds.includes(x.id)).map((x) => x.name).join(', ') || 'Claude zelf';

  // one menu at a time; closes on outside click or Escape and returns focus to its trigger
  useEffect(() => {
    if (!menu) return;
    const id = menu;
    const down = (e: PointerEvent) => { if (!(e.target as Element).closest?.('[data-tg-menu]')) setMenu(null); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenu(null); document.getElementById(`tgm-${id}`)?.focus(); } };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  }, [menu]);

  async function copy(text: string, key: string) {
    try { await navigator.clipboard.writeText(text); setCopied(key); setTimeout(() => setCopied(''), 1500); } catch { /* ignore */ }
  }
  async function ownerLink() {
    setErr('');
    try { setOwn(await telegramBots.code(bot.id, 'owner')); } catch (e) { setErr((e as Error).message); }
  }
  async function pickAvatar(file: File | undefined) {
    if (!file) return;
    setErr('');
    try { const url = await resizeToDataUrl(file, 256); await act(() => telegramBots.update(bot.id, { avatar: url })); }
    catch (e) { setErr((e as Error).message); }
  }
  const opt = (k: 'optCommands' | 'optFull' | 'optMessenger', v: boolean) => void act(() => telegramBots.update(bot.id, { [k]: v }));
  function reset() { setIds(bot.agentIds); setName(bot.name); setRate(String(bot.ratePerHour)); }

  const rowProps = { bot, busy, act, menu, setMenu };

  return (
    <div className="wa-row-in bg-(--input) border border-(--border) rounded-card" style={{ ['--i' as string]: index }}>
      <button type="button" onClick={onToggle} aria-expanded={open} className="tg-head">
        <span className="tg-avw">
          {bot.avatar
            ? <img src={bot.avatar} alt="" className="tg-ava" />
            : <span className="tg-ava" aria-hidden>{initials(bot.name)}</span>}
          <span className={`tg-dot ${dotCls}`} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="tg-title block truncate">{bot.name}</span>
          <span className="tg-sub block truncate">{bot.botUsername ? `@${bot.botUsername} · ` : ''}{STATUS_LABEL[bot.status] ?? bot.status}</span>
          <span className="tg-sub block truncate" style={{ marginTop: 0 }}>{agentNames} · {approved.length} chatter{approved.length === 1 ? '' : 's'}</span>
        </span>
        {pending.length > 0 && <span className="shrink-0 text-xs font-semibold px-2.5 py-0.5 rounded-full bg-(--accent-strong) text-white">{pending.length} nieuw</span>}
        <span className={`text-(--muted) shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}><Chevron /></span>
      </button>

      {/* pending requests stay visible without opening the card */}
      {!open && pending.length > 0 && (
        <div className="px-4 pb-4">
          <div className="tg-list is-new">{pending.map((c) => <Request key={c.id} c={c} bot={bot} busy={busy} act={act} />)}</div>
        </div>
      )}

      <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="tg-body" data-open={open ? '1' : '0'}>
            {(bot.statusMessage || err) && (
              <div className="pt-4 space-y-1">
                {bot.statusMessage && <p className="text-xs text-(--bad)">{bot.statusMessage}</p>}
                {err && <p className="text-xs text-(--bad)">{err}</p>}
              </div>
            )}

            <section className="tg-sec" style={sec(0)}>
              <div className="tg-sec-h">Identiteit</div>
              <div className="tg-id">
                <label className="tg-avbtn" aria-label="Avatar kiezen">
                  {bot.avatar ? <img src={bot.avatar} alt="" className="tg-ava" /> : <span className="tg-ava" aria-hidden>{initials(bot.name)}</span>}
                  <span className="tg-cam" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z" /><circle cx="12" cy="13" r="3" /></svg>
                  </span>
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy}
                    onChange={(e) => { void pickAvatar(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                <div className="flex-1 min-w-0">
                  <label className="tg-label" htmlFor={`name-${bot.id}`}>Naam</label>
                  <input id={`name-${bot.id}`} className={input} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
                </div>
              </div>
              {bot.avatar && (
                <div className="mt-2">
                  <button type="button" className="tg-btn g" disabled={busy} onClick={() => void act(() => telegramBots.update(bot.id, { avatar: '' }))}>Avatar weg</button>
                </div>
              )}
            </section>

            <section className="tg-sec" style={sec(1)}>
              <div className="tg-sec-h">Agents</div>
              <AgentPicker agents={agents} value={ids} onChange={setIds} />
              <p className="tg-hint mt-2.5">Geen agent gekozen: Claude zelf antwoordt. Meer agents: @naam of het team kiest.</p>
              <div className="flex items-center justify-between gap-4 mt-4">
                <label htmlFor={`rate-${bot.id}`} className="min-w-0">
                  <span className="block text-sm text-(--text)">Berichten per uur per gast</span>
                  <span className="tg-hint block">0 is onbeperkt</span>
                </label>
                <input id={`rate-${bot.id}`} className={input} style={{ width: 84, textAlign: 'right' }} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} />
              </div>
              <div className={`tg-save ${dirty ? 'on' : ''}`} aria-hidden={!dirty} {...(dirty ? {} : { inert: true })}>
                <div>
                  <div className="tg-btns">
                    <button type="button" className={secondary} disabled={busy} onClick={reset}>Terugzetten</button>
                    <button type="button" className={primary} disabled={busy || !dirty || !name.trim()}
                      onClick={() => void act(() => telegramBots.update(bot.id, { name: name.trim(), agentIds: ids, ratePerHour: Number(rate) || 0 }))}>Opslaan</button>
                  </div>
                </div>
              </div>
            </section>

            <section className="tg-sec" style={sec(2)}>
              <div className="tg-sec-h"><span>Chatters</span><span className="tg-count">{approved.length}</span></div>
              {pending.length > 0 && (
                <div className="tg-list is-new" style={{ marginBottom: 10 }}>
                  {pending.map((c) => <Request key={c.id} c={c} bot={bot} busy={busy} act={act} />)}
                </div>
              )}
              <div className="tg-list">
                {!approved.length && <p className="tg-hint" style={{ padding: '16px 12px' }}>Nog niemand.</p>}
                {approved.map((c) => <ChatterRow key={c.id} c={c} {...rowProps} />)}
                {rest.length > 0 && (
                  <button type="button" className="tg-disc" style={{ minHeight: 44, fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}
                    aria-expanded={restOpen} onClick={() => setRestOpen(!restOpen)}>
                    Geweigerd of ingetrokken ({rest.length})<Chevron />
                  </button>
                )}
                {restOpen && rest.map((c) => <ChatterRow key={c.id} c={c} {...rowProps} />)}
              </div>
            </section>

            <section className="tg-sec" style={sec(3)}>
              <div className="tg-sec-h">Koppelen</div>
              <div className="tg-btns cols">
                <button type="button" className={secondary} disabled={busy || !bot.enabled} onClick={() => void ownerLink()}>
                  {hasOwner ? 'Opnieuw koppelen' : 'Koppel mezelf'}
                </button>
                <button type="button" className={secondary} disabled={busy || !bot.enabled}
                  onClick={() => void act(async () => { await telegramBots.code(bot.id, 'invite'); return telegramBots.list(); })}>
                  {bot.invite ? 'Nieuwe uitnodigingslink' : 'Uitnodigingslink'}
                </button>
              </div>
              {own && (
                <div className="tg-link">
                  <p className="tg-hint" style={{ marginBottom: 6 }}>Geldig tot {when(own.expiresAt)}. Daarmee word jij de eigenaar van deze bot, zonder goedkeuring.</p>
                  <div className="flex items-start gap-2">
                    {own.link
                      ? <code className="flex-1 min-w-0"><a className="text-(--accent-text)" href={own.link} target="_blank" rel="noreferrer">{own.link}</a></code>
                      : <code className="flex-1 min-w-0">/start {own.code}</code>}
                    <button type="button" className="tg-btn g shrink-0" onClick={() => void copy(own.link ?? `/start ${own.code}`, 'own')}>{copied === 'own' ? 'Gekopieerd' : 'Kopiëren'}</button>
                  </div>
                </div>
              )}
              {bot.invite && (
                <div className="tg-link">
                  <p className="tg-hint" style={{ marginBottom: 6 }}>Uitnodiging, geldig tot {when(bot.invite.expiresAt)}. Wie hem opent is meteen goedgekeurd.</p>
                  <div className="flex items-start gap-2">
                    <code className="flex-1 min-w-0">{bot.invite.link}</code>
                    <button type="button" className="tg-btn g shrink-0" onClick={() => void copy(bot.invite!.link, 'inv')}>{copied === 'inv' ? 'Gekopieerd' : 'Kopiëren'}</button>
                  </div>
                </div>
              )}
            </section>

            <section className="tg-sec" style={sec(4)}>
              <div className="tg-list">
                <button type="button" className="tg-disc" onClick={() => setAdv(!adv)} aria-expanded={adv}>Geavanceerd<Chevron size={18} /></button>
                <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${adv ? 'grid-rows-[1fr]' : 'grid-rows-[0fr] !border-t-0'}`}>
                  <div className="overflow-hidden">
                    <div className="tg-list-in" style={{ borderTop: '1px solid var(--border)' }}>
                      <Opt checked={bot.optCommands} disabled={busy} onChange={(v) => opt('optCommands', v)}
                        label="Commando's" hint="/resume, /nieuw en /status: doorgaan op een eerder gesprek of een nieuw beginnen. Zonder agents zie jij al je gesprekken, met agents alleen die met die agents; gasten alleen hun eigen." />
                      <Opt checked={bot.optFull} disabled={busy} onChange={(v) => opt('optFull', v)}
                        label="Volledige antwoorden" hint="Ook code en commando's in de antwoorden, zoals in de app. Uit: alleen gewone taal. Geldt voor jou als eigenaar; gasten krijgen altijd gewone taal." />
                      <Opt checked={bot.optMessenger} disabled={busy} onChange={(v) => opt('optMessenger', v)}
                        label="WhatsApp-koppeling" hint="Deze bot is je berichtenkanaal: gesprekken uit de app doorzetten, meldingen van taken en /whatsapp. Kan maar bij één bot aan staan." />
                      {bot.optMessenger && <div className="wa-row-in" style={{ padding: 12 }}><MessengerLink channel="telegram" /></div>}
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <section className="tg-sec" style={sec(5)}>
              <div className="tg-sec-h" style={{ color: 'var(--bad)' }}>Gevarenzone</div>
              <div className="tg-danger">
                <div className="tg-dr">
                  <span className="min-w-0"><span className="tg-t block">{bot.enabled ? 'Bot uitzetten' : 'Bot aanzetten'}</span><span className="tg-hint block">Stopt antwoorden. Chatters blijven staan.</span></span>
                  <button type="button" className={secondary} disabled={busy}
                    onClick={() => void act(() => telegramBots.update(bot.id, { enabled: !bot.enabled }))}>{bot.enabled ? 'Uitzetten' : 'Aanzetten'}</button>
                </div>
                <div>
                  <div className="tg-dr">
                    <span className="min-w-0"><span className="tg-t block">Token vervangen</span><span className="tg-hint block">Chatters moeten daarna opnieuw toestemming geven.</span></span>
                    <button type="button" className={secondary} aria-expanded={tokOpen} onClick={() => setTokOpen(!tokOpen)}>Vervangen</button>
                  </div>
                  {tokOpen && (
                    <div className="tg-tok">
                      <input className={input} type="password" autoComplete="off" placeholder="Nieuwe bot-token" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Nieuwe bot-token" />
                      <button type="button" className="tg-btn d" disabled={busy || !token.trim()}
                        onClick={() => { if (confirm('Een andere bot betekent dat alle chatters opnieuw toestemming nodig hebben. Doorgaan?')) void act(() => telegramBots.update(bot.id, { botToken: token.trim() })).then((ok) => { if (ok) { setToken(''); setTokOpen(false); } }); }}>Token vervangen</button>
                    </div>
                  )}
                </div>
                <div className="tg-dr">
                  <span className="min-w-0"><span className="tg-t block">Bot verwijderen</span><span className="tg-hint block">Gesprekken blijven bestaan.</span></span>
                  <button type="button" className={danger} disabled={busy}
                    onClick={() => { if (confirm(`Bot "${bot.name}" verwijderen? De gesprekken blijven bestaan.`)) void act(() => telegramBots.remove(bot.id)); }}>Verwijderen</button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}

function Opt({ checked, disabled, onChange, label, hint }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <div className="tg-opt">
      <span><span className="tg-t block">{label}</span><span className="tg-hint block">{hint}</span></span>
      <button type="button" role="switch" aria-checked={checked} aria-label={label} className="ll-switch" disabled={disabled} onClick={() => onChange(!checked)} />
    </div>
  );
}

function ChatterRow({ c, bot, busy, act, menu, setMenu }: {
  c: AgentBotChatter; bot: AgentBot; busy: boolean; act: (fn: () => Promise<AgentBotOverview>) => Promise<boolean>;
  menu: string | null; setMenu: (v: string | null) => void;
}) {
  const active = c.status === 'approved';
  const isOpen = menu === c.id;
  const meta = active
    ? (c.lastActive ? `Laatst actief ${when(c.lastActive)}` : `Goedgekeurd ${when(c.decidedAt)}`)
    : (c.status === 'denied' ? 'Geweigerd' : 'Ingetrokken');
  const main = (
    <>
      <span className="tg-ava" aria-hidden>{initials(c.name)}</span>
      <span className="min-w-0 flex-1">
        <span className="tg-name">
          <span className="min-w-0 truncate">{c.name}</span>
          {c.username && <em>@{c.username}</em>}
          {c.isOwner && <span className="tg-pill">jij</span>}
        </span>
        <span className="tg-meta block">{meta}</span>
      </span>
    </>
  );
  return (
    <div className="tg-row" data-tg-menu>
      {c.conversationId
        ? <Link href={`/chat/${c.conversationId}`} className="tg-row-main">{main}</Link>
        : <div className="tg-row-main">{main}</div>}
      <button type="button" id={`tgm-${c.id}`} className="tg-more" aria-label={`Acties voor ${c.name}`} aria-haspopup="menu" aria-expanded={isOpen}
        disabled={busy} onClick={() => setMenu(isOpen ? null : c.id)}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden><circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" /></svg>
      </button>
      {isOpen && (
        <div className="tg-menu" role="menu">
          {c.conversationId && (
            <Link href={`/chat/${c.conversationId}`} role="menuitem" className="tg-mi" onClick={() => setMenu(null)}>Gesprek openen</Link>
          )}
          {active ? (
            <button type="button" role="menuitem" className="tg-mi d"
              onClick={() => { setMenu(null); if (confirm(c.isOwner ? 'Jezelf ontkoppelen van deze bot?' : `Toegang van ${c.name} intrekken?`)) void act(() => telegramBots.decide(bot.id, c.id, 'revoke')); }}>
              {c.isOwner ? 'Ontkoppelen' : 'Toegang intrekken'}
            </button>
          ) : (
            <button type="button" role="menuitem" className="tg-mi"
              onClick={() => { setMenu(null); void act(() => telegramBots.decide(bot.id, c.id, 'approve')); }}>Alsnog goedkeuren</button>
          )}
        </div>
      )}
    </div>
  );
}

async function resizeToDataUrl(file: File, px: number): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('Kan deze afbeelding niet lezen.'); });
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = Math.min(px, side);
  c.getContext('2d')!.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, c.width, c.height);
  return c.toDataURL('image/webp', 0.85);
}

function Request({ c, bot, busy, act }: { c: AgentBotChatter; bot: AgentBot; busy: boolean; act: (fn: () => Promise<AgentBotOverview>) => Promise<boolean> }) {
  return (
    <div className="tg-req">
      <div className="flex items-center gap-3">
        <span className="tg-ava" aria-hidden style={{ width: 36, height: 36, fontSize: 12 }}>{initials(c.name)}</span>
        <span className="min-w-0 flex-1">
          <span className="tg-name">
            <span className="min-w-0 truncate">{c.name}</span>
            <em className="shrink-0">{c.username ? `@${c.username} · ` : ''}nieuwe aanvraag</em>
          </span>
          <span className="tg-meta block">Aangevraagd {when(c.requestedAt)}</span>
        </span>
      </div>
      <div className="tg-btns">
        <button type="button" className="tg-btn p sm" disabled={busy} onClick={() => void act(() => telegramBots.decide(bot.id, c.id, 'approve'))}>Goedkeuren</button>
        <button type="button" className="tg-btn s sm" disabled={busy} onClick={() => void act(() => telegramBots.decide(bot.id, c.id, 'deny'))}>Weigeren</button>
      </div>
    </div>
  );
}
