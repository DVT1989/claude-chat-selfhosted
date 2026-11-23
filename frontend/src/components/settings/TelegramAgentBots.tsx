'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { telegramBots, type AgentBot, type AgentBotOverview, type AgentBotChatter } from '@/lib/api';
import MessengerLink from '@/components/settings/MessengerLink';

const input = 'w-full bg-(--bg) border border-(--border) rounded-lg px-3 py-2 text-(--text) text-sm focus:outline-none focus:border-(--accent)';
const primary = 'bg-(--accent-strong) hover:brightness-90 text-white text-sm font-medium px-4 py-2 rounded-control transition-[filter] disabled:opacity-50';
const secondary = 'text-sm px-3 py-1.5 rounded-lg border border-(--border) text-(--text) hover:bg-(--border) transition-colors disabled:opacity-50';
const danger = 'text-sm px-3 py-1.5 rounded-lg border border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50';

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
  if (!agents.length) return <p className="text-xs text-(--muted)">Je hebt nog geen agents. Maak er een op de agents-pagina.</p>;
  return (
    <div className="flex flex-wrap gap-2">
      {agents.map((a) => {
        const on = value.includes(a.id);
        return (
          <button key={a.id} type="button" aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== a.id) : [...value, a.id])}
            className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-full border transition-all duration-200 ${on ? 'border-(--accent) bg-(--accent)/10 text-(--text)' : 'border-(--border) text-(--muted) hover:text-(--text)'}`}>
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: a.color }} />
            {a.name}{a.shared_by ? <span className="text-xs text-(--muted)">van {a.shared_by}</span> : null}
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
        <input id="tgb-rate" className={`${input} max-w-32`} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} />
      </div>
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={busy || !token.trim() || !name.trim()}>Opslaan</button>
        <button type="button" className={secondary} onClick={onCancel}>Annuleren</button>
      </div>
    </form>
  );
}

const STATUS_LABEL: Record<string, string> = { ok: 'Actief', off: 'Uit', error: 'Fout' };

function BotCard({ bot, agents, index, open, busy, onToggle, act }: {
  bot: AgentBot; agents: AgentBotOverview['agents']; index: number; open: boolean; busy: boolean;
  onToggle: () => void; act: (fn: () => Promise<AgentBotOverview>) => Promise<boolean>;
}) {
  const [ids, setIds] = useState(bot.agentIds);
  const [name, setName] = useState(bot.name);
  const [rate, setRate] = useState(String(bot.ratePerHour));
  const [token, setToken] = useState('');
  const [adv, setAdv] = useState(false);
  const [own, setOwn] = useState<{ code: string; expiresAt: string; link: string | null } | null>(null);
  const [copied, setCopied] = useState('');
  const [err, setErr] = useState('');
  const pending = bot.chatters.filter((c) => c.status === 'pending');
  const approved = bot.chatters.filter((c) => c.status === 'approved');
  const rest = bot.chatters.filter((c) => c.status === 'denied' || c.status === 'revoked');
  const hasOwner = approved.some((c) => c.isOwner);
  const dirty = ids.slice().sort().join() !== bot.agentIds.slice().sort().join() || rate !== String(bot.ratePerHour) || name.trim() !== bot.name;
  const dot = bot.status === 'ok' ? 'bg-green-400' : bot.status === 'error' ? 'bg-red-400' : 'bg-(--muted)';

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

  return (
    <div className="wa-row-in bg-(--input) border border-(--border) rounded-card" style={{ ['--i' as string]: index }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        className="w-full flex items-center gap-3 p-4 text-left">
        <span className="relative shrink-0">
          {bot.avatar
            ? <img src={bot.avatar} alt="" className="w-9 h-9 rounded-full object-cover" />
            : <span className="w-9 h-9 rounded-full bg-(--bg) border border-(--border) flex items-center justify-center text-xs font-medium text-(--muted)">{bot.name.slice(0, 2).toUpperCase()}</span>}
          <span className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-(--input) ${dot}`} aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-(--text) truncate">{bot.name}</span>
          <span className="block text-xs text-(--muted) truncate">
            {bot.botUsername ? `@${bot.botUsername} · ` : ''}{STATUS_LABEL[bot.status] ?? bot.status} · {agents.filter((x) => bot.agentIds.includes(x.id)).map((x) => x.name).join(', ') || 'Claude zelf'} · {approved.length} chatter{approved.length === 1 ? '' : 's'}
          </span>
        </span>
        {pending.length > 0 && <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-(--accent-strong) text-white shrink-0">{pending.length} nieuw</span>}
        <svg className={`w-4 h-4 text-(--muted) shrink-0 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m6 9 6 6 6-6" /></svg>
      </button>

      {/* pending requests stay visible without opening the card */}
      {!open && pending.length > 0 && (
        <div className="px-4 pb-4 space-y-2">
          {pending.map((c) => <Request key={c.id} c={c} bot={bot} busy={busy} act={act} />)}
        </div>
      )}

      <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-4 pb-4 space-y-5 border-t border-(--border) pt-4">
            {bot.statusMessage && <p className="text-xs text-red-400">{bot.statusMessage}</p>}
            {err && <p className="text-xs text-red-400">{err}</p>}

            {pending.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-(--muted)">Aanvragen</p>
                {pending.map((c) => <Request key={c.id} c={c} bot={bot} busy={busy} act={act} />)}
              </div>
            )}

            <div className="space-y-2">
              <p className="text-xs font-medium text-(--muted)">Koppelen</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={secondary} disabled={busy || !bot.enabled} onClick={() => void ownerLink()}>
                  {hasOwner ? 'Opnieuw koppelen (mezelf)' : 'Koppellink voor mezelf'}
                </button>
                <button type="button" className={secondary} disabled={busy || !bot.enabled}
                  onClick={() => void act(async () => { await telegramBots.code(bot.id, 'invite'); return telegramBots.list(); })}>
                  {bot.invite ? 'Nieuwe uitnodigingslink' : 'Uitnodigingslink'}
                </button>
              </div>
              {own && (
                <div className="wa-row-in text-xs text-(--muted) bg-(--bg) border border-(--border) rounded-lg px-3 py-2 space-y-1">
                  {own.link
                    ? <p>Open op je telefoon: <a className="text-(--accent) break-all" href={own.link} target="_blank" rel="noreferrer">{own.link}</a></p>
                    : <p>Stuur de bot: <code className="text-(--text)">/start {own.code}</code></p>}
                  <p>Geldig tot {when(own.expiresAt)}. Daarmee word jij de eigenaar van deze bot, zonder goedkeuring.</p>
                </div>
              )}
              {bot.invite && (
                <div className="wa-row-in flex items-center gap-2 text-xs text-(--muted) bg-(--bg) border border-(--border) rounded-lg px-3 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block text-(--text) break-all">{bot.invite.link}</span>
                    <span className="block">Uitnodiging, geldig tot {when(bot.invite.expiresAt)}. Wie hem opent is meteen goedgekeurd.</span>
                  </span>
                  <button type="button" className={secondary} onClick={() => void copy(bot.invite!.link, 'inv')}>{copied === 'inv' ? 'Gekopieerd' : 'Kopiëren'}</button>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium text-(--muted)">Goedgekeurde chatters</p>
              {!approved.length && <p className="text-sm text-(--muted)">Nog niemand.</p>}
              {approved.map((c) => (
                <div key={c.id} className="flex items-center gap-3 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block text-(--text) truncate">
                      {c.name}{c.username ? <span className="text-(--muted)"> @{c.username}</span> : null}
                      {c.isOwner && <span className="ml-2 text-[11px] px-1.5 py-0.5 rounded-full bg-(--bg) border border-(--border) text-(--muted)">jij</span>}
                    </span>
                    <span className="block text-xs text-(--muted)">{c.lastActive ? `Laatst actief ${when(c.lastActive)}` : `Goedgekeurd ${when(c.decidedAt)}`}</span>
                  </span>
                  {c.conversationId && <Link href={`/chat/${c.conversationId}`} className={secondary}>Gesprek</Link>}
                  <button type="button" className={danger} disabled={busy}
                    onClick={() => { if (confirm(c.isOwner ? 'Jezelf ontkoppelen van deze bot?' : `Toegang van ${c.name} intrekken?`)) void act(() => telegramBots.decide(bot.id, c.id, 'revoke')); }}>{c.isOwner ? 'Ontkoppelen' : 'Intrekken'}</button>
                </div>
              ))}
              {rest.length > 0 && (
                <details className="text-xs text-(--muted)">
                  <summary className="cursor-pointer">Geweigerd of ingetrokken ({rest.length})</summary>
                  <div className="mt-2 space-y-2">
                    {rest.map((c) => (
                      <div key={c.id} className="flex items-center gap-3">
                        <span className="flex-1 truncate">{c.name} · {c.status === 'denied' ? 'geweigerd' : 'ingetrokken'}</span>
                        <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => telegramBots.decide(bot.id, c.id, 'approve'))}>Alsnog goedkeuren</button>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>

            <div className="space-y-2">
              <label className="block text-xs font-medium text-(--muted)" htmlFor={`name-${bot.id}`}>Naam en avatar</label>
              <div className="flex items-center gap-3 flex-wrap">
                <input id={`name-${bot.id}`} className={`${input} max-w-80`} maxLength={64} value={name} onChange={(e) => setName(e.target.value)} />
                <label className={`${secondary} cursor-pointer`}>
                  Avatar kiezen
                  <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy}
                    onChange={(e) => { void pickAvatar(e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                {bot.avatar && <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => telegramBots.update(bot.id, { avatar: '' }))}>Avatar weg</button>}
              </div>
              <p className="text-xs font-medium text-(--muted) pt-2">Gekoppelde agents <span className="font-normal">(geen: Claude zelf antwoordt)</span></p>
              <AgentPicker agents={agents} value={ids} onChange={setIds} />
            </div>

            <div className="border-t border-(--border) pt-4">
              <button type="button" onClick={() => setAdv(!adv)} aria-expanded={adv}
                className="flex items-center gap-2 text-xs font-medium text-(--muted) hover:text-(--text) transition-colors">
                <svg className={`w-3.5 h-3.5 transition-transform duration-200 ${adv ? 'rotate-90' : ''}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m9 6 6 6-6 6" /></svg>
                Geavanceerd
              </button>
              <div className={`grid transition-[grid-template-rows] duration-300 ease-out ${adv ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="pt-3 space-y-3">
                    <Check checked={bot.optCommands} disabled={busy} onChange={(v) => opt('optCommands', v)}
                      label="Commando's" hint="/resume, /nieuw en /status: doorgaan op een eerder gesprek of een nieuw beginnen. Zonder agents zie jij al je gesprekken, met agents alleen die met die agents; gasten alleen hun eigen." />
                    <Check checked={bot.optFull} disabled={busy} onChange={(v) => opt('optFull', v)}
                      label="Volledige antwoorden" hint="Ook code en commando's in de antwoorden, zoals in de app. Uit: alleen gewone taal. Geldt voor jou als eigenaar; gasten krijgen altijd gewone taal." />
                    <Check checked={bot.optMessenger} disabled={busy} onChange={(v) => opt('optMessenger', v)}
                      label="WhatsApp-koppeling" hint="Deze bot is je berichtenkanaal: gesprekken uit de app doorzetten, meldingen van taken en /whatsapp. Kan maar bij één bot aan staan." />
                    {bot.optMessenger && <div className="wa-row-in"><MessengerLink channel="telegram" /></div>}
                    <div className="flex items-end gap-3 flex-wrap">
                      <div>
                        <label className="block text-xs text-(--muted) mb-1" htmlFor={`rate-${bot.id}`}>Berichten per uur per gast (0 = onbeperkt)</label>
                        <input id={`rate-${bot.id}`} className={`${input} max-w-32`} inputMode="numeric" value={rate} onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <button type="button" className={primary} disabled={busy || !dirty || !name.trim()}
                onClick={() => void act(() => telegramBots.update(bot.id, { name: name.trim(), agentIds: ids, ratePerHour: Number(rate) || 0 }))}>Opslaan</button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-(--border) pt-4">
              <button type="button" className={secondary} disabled={busy}
                onClick={() => void act(() => telegramBots.update(bot.id, { enabled: !bot.enabled }))}>{bot.enabled ? 'Bot uitzetten' : 'Bot aanzetten'}</button>
              <input className={`${input} max-w-56`} type="password" autoComplete="off" placeholder="Nieuwe token (optioneel)" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Nieuwe bot-token" />
              <button type="button" className={secondary} disabled={busy || !token.trim()}
                onClick={() => { if (confirm('Een andere bot betekent dat alle chatters opnieuw toestemming nodig hebben. Doorgaan?')) void act(() => telegramBots.update(bot.id, { botToken: token.trim() })).then((ok) => ok && setToken('')); }}>Token vervangen</button>
              <button type="button" className={`${danger} ml-auto`} disabled={busy}
                onClick={() => { if (confirm(`Bot "${bot.name}" verwijderen? De gesprekken blijven bestaan.`)) void act(() => telegramBots.remove(bot.id)); }}>Verwijderen</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Check({ checked, disabled, onChange, label, hint }: { checked: boolean; disabled: boolean; onChange: (v: boolean) => void; label: string; hint: string }) {
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input type="checkbox" className="mt-0.5 accent-(--accent-strong)" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        <span className="block text-sm text-(--text)">{label}</span>
        <span className="block text-xs text-(--muted)">{hint}</span>
      </span>
    </label>
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
    <div className="flex items-center gap-3 text-sm bg-(--bg) border border-(--border) rounded-lg px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-(--text) truncate">{c.name}{c.username ? <span className="text-(--muted)"> @{c.username}</span> : null}</span>
        <span className="block text-xs text-(--muted)">Aangevraagd {when(c.requestedAt)}</span>
      </span>
      <button type="button" className={primary} disabled={busy} onClick={() => void act(() => telegramBots.decide(bot.id, c.id, 'approve'))}>Goedkeuren</button>
      <button type="button" className={secondary} disabled={busy} onClick={() => void act(() => telegramBots.decide(bot.id, c.id, 'deny'))}>Weigeren</button>
    </div>
  );
}
