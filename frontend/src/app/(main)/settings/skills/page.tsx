'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import EmptyState from '@/components/ui/EmptyState';
import { NavIcons } from '@/components/navItems';
import { skills as skillsApi, type SkillsManifest } from '@/lib/api';
import { useFocusParam } from '@/components/useFocusParam';
import { useAuthStore } from '@/lib/store';

function sourceLabel(source: string): string {
  if (source === 'user') return 'Gedeeld: eigen skills van de pc';
  if (source.startsWith('plugin:')) {
    const name = source.slice('plugin:'.length);
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return source;
}

const field = 'w-full px-3.5 py-2.5 rounded-control bg-(--input) border border-(--border) text-(--text) text-sm placeholder-(--muted) outline-none focus:border-(--accent) transition-colors';

/** Form to add a skill: fill in name, description and instructions, or load a SKILL.md file. */
function AddSkill({ onDone, onCancel }: { onDone: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [fromFile, setFromFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadFile(f: File | undefined) {
    if (!f) return;
    if (f.size > 200 * 1024) { setError('Bestand is te groot (max 200 KB).'); return; }
    const text = await f.text();
    // Pre-fill the fields from the frontmatter so the user can check them
    const m = text.replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (m) {
      const get = (k: string) => (m[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
      setName(get('name') || f.name.replace(/\.md$/i, ''));
      setDescription(get('description'));
      setInstructions(m[2].trim());
    } else {
      setName(f.name.replace(/\.md$/i, '').replace(/^SKILL$/i, ''));
      setInstructions(text.trim());
    }
    setFromFile(f.name);
    setError('');
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await skillsApi.add({ name, description, instructions });
      onDone(r.name);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-4">
      <div className="flex justify-end">
        <button type="button" onClick={() => fileRef.current?.click()}
          className="text-sm px-3 py-1.5 rounded-control border border-(--border) text-(--text) hover:bg-(--border)/40 transition-colors">
          {fromFile ? `Geladen: ${fromFile}` : 'SKILL.md uploaden'}
        </button>
        <input ref={fileRef} type="file" accept=".md,text/markdown,text/plain" className="hidden"
          onChange={(e) => { void loadFile(e.target.files?.[0]); e.target.value = ''; }} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="block text-xs text-(--muted) mb-1.5">Naam</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="bijv. offerte-schrijven" className={field} required />
        </label>
        <label className="block">
          <span className="block text-xs text-(--muted) mb-1.5">Wanneer gebruiken (beschrijving)</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Gebruik bij het schrijven van een offerte voor een klant" className={field} required />
        </label>
      </div>
      <label className="block">
        <span className="block text-xs text-(--muted) mb-1.5">Instructies voor Claude (Markdown)</span>
        <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={10}
          placeholder={'# Offerte schrijven\n\n1. Vraag naar de klant en het project.\n2. Gebruik de vaste opbouw: …'}
          className={`${field} font-mono text-[13px] leading-relaxed resize-y`} required />
      </label>
      <p className="text-xs text-(--muted)">
        Claude kiest de skill op basis van de beschrijving. Zelfde naam als een gedeelde skill vervangt die voor jou.
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy}
          className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">
          {busy ? 'Opslaan…' : 'Skill opslaan'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-control text-sm text-(--muted) hover:text-(--text)">
          Annuleren
        </button>
      </div>
    </form>
  );
}

/** Import skills from a public GitHub repo, folder or SKILL.md link. */
function GithubImport({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await skillsApi.importGithub(url);
      const names = r.imported.map((i) => i.name);
      let msg = names.length === 1 ? `"${names[0]}" is toegevoegd.` : `${names.length} skills toegevoegd: ${names.join(', ')}.`;
      if (r.skipped.length) msg += ` Overgeslagen: ${r.skipped.map((s) => `${s.path} (${s.reason})`).join('; ')}.`;
      onDone(msg + (names.length === 1 ? ' Claude gebruikt hem' : ' Claude gebruikt ze') + ' vanaf je volgende bericht.');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={run} className="space-y-4">
      <label className="block">
        <span className="block text-xs text-(--muted) mb-1.5">GitHub-link</span>
        <input value={url} onChange={(e) => setUrl(e.target.value)} required autoFocus
          placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf" className={field} />
      </label>
      <p className="text-xs text-(--muted)">
        Repo, map of SKILL.md (alleen publiek). Bestaande skill wordt bijgewerkt. Alleen vertrouwde bronnen: Claude kan de scripts uitvoeren.
      </p>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={busy}
          className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium disabled:opacity-50">
          {busy ? 'Ophalen…' : 'Importeren'}
        </button>
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-control text-sm text-(--muted) hover:text-(--text)">
          Annuleren
        </button>
      </div>
    </form>
  );
}

/** "Skill toevoegen" panel: from GitHub (default) or written here / uploaded. */
function AddPanel({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const [mode, setMode] = useState<'github' | 'zelf'>('github');
  return (
    <div className="rounded-card border border-(--border) bg-(--input) p-5 space-y-4">
      <div className="sub-tabs">
        <button type="button" onClick={() => setMode('github')} className={`sub-tab ${mode === 'github' ? 'sub-tab-on' : ''}`}>
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5Z" /></svg>
          <span>Van GitHub</span>
        </button>
        <button type="button" onClick={() => setMode('zelf')} className={`sub-tab ${mode === 'zelf' ? 'sub-tab-on' : ''}`}>
          <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24" aria-hidden><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          <span>Zelf maken</span>
        </button>
      </div>
      {mode === 'github'
        ? <GithubImport onDone={onDone} onCancel={onCancel} />
        : <AddSkill onCancel={onCancel} onDone={(name) => onDone(`"${name}" is opgeslagen. Claude gebruikt hem vanaf je volgende bericht.`)} />}
    </div>
  );
}

export default function SkillsPage() {
  const [data, setData] = useState<SkillsManifest | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState('');
  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [sharing, setSharing] = useState<string | null>(null);

  function load() {
    skillsApi.list().then(setData).catch((e: Error) => setError(e.message));
  }
  useEffect(load, []);

  const [updating, setUpdating] = useState<string | null>(null);
  async function update(name: string, source: string) {
    setUpdating(name); setNotice('');
    try {
      await skillsApi.importGithub(source);
      setNotice(`"${name}" is bijgewerkt vanaf GitHub.`);
      load();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUpdating(null);
    }
  }

  async function share(name: string, shared: boolean) {
    setSharing(name); setNotice('');
    try {
      await skillsApi.share(name, shared);
      setData((d) => d && { ...d, own: d.own?.map((x) => (x.name === name ? { ...x, shared } : x)) });
      setNotice(shared ? `"${name}" is nu voor iedereen beschikbaar.` : `"${name}" wordt niet meer gedeeld.`);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSharing(null);
    }
  }

  async function remove(name: string) {
    if (!confirm(`Skill "${name}" verwijderen?`)) return;
    try {
      await skillsApi.remove(name);
      setNotice(`"${name}" is verwijderd.`);
      load();
    } catch (e) {
      alert((e as Error).message);
    }
  }

  const q = filter.trim().toLowerCase();
  useFocusParam(!!data);
  const own = (data?.own ?? []).filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().includes(q));
  const byOthers = (data?.sharedByOthers ?? []).filter((s) => !q || (s.name + ' ' + s.description).toLowerCase().includes(q));
  const groups = useMemo(() => {
    const map = new Map<string, SkillsManifest['skills']>();
    for (const s of data?.skills ?? []) {
      if (q && !(s.name + ' ' + s.description).toLowerCase().includes(q)) continue;
      map.set(s.source, [...(map.get(s.source) ?? []), s]);
    }
    return [...map.entries()];
  }, [data, q]);

  if (error) return <p className="text-sm text-red-400">{error}</p>;

  if (!data) {
    return (
      <div className="space-y-3" aria-busy="true">
        {[0, 1, 2, 3].map((n) => <div key={n} className="h-16 rounded-card bg-(--input) animate-pulse" />)}
      </div>
    );
  }

  const when = data.generatedAt ? new Date(data.generatedAt).toLocaleString('nl-NL', { dateStyle: 'medium', timeStyle: 'short' }) : null;

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-(--text)">Skills</h1>
          <p className="text-sm text-(--muted) mt-1">
            {(data.own?.length ?? 0) + (data.sharedByOthers?.length ?? 0) + data.skills.length} skills beschikbaar in Claude Code
            {when ? `; gedeelde skills bijgewerkt op ${when}` : ''}.
          </p>
        </div>
        {!adding && (
          <button onClick={() => { setAdding(true); setNotice(''); }}
            className="px-4 py-2 rounded-control bg-(--accent-strong) text-white text-sm font-medium">
            + Skill toevoegen
          </button>
        )}
      </div>

      {adding && (
        <div className="mb-7">
          <AddPanel
            onCancel={() => setAdding(false)}
            onDone={(msg) => { setAdding(false); setNotice(msg); load(); }}
          />
        </div>
      )}
      {notice && <p className="mb-5 text-sm text-green-400">{notice}</p>}

      <input
        type="search"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Zoek een skill"
        aria-label="Zoek een skill"
        className={`${field} mb-6`}
      />

      <section className="mb-7">
        <h2 className="text-xs font-medium text-(--muted) mb-2 px-1">Mijn skills ({own.length})</h2>
        {own.length === 0 ? (
          q ? (
            <p className="rounded-card border border-dashed border-(--border) px-4 py-4 text-sm text-(--muted)">Geen eigen skills gevonden.</p>
          ) : (
            <EmptyState icon={NavIcons.skills('w-5 h-5')} title="Nog geen eigen skills"
              text="Een skill is een vaste werkwijze die Claude in elk gesprek kan gebruiken."
              action={adding ? undefined : { label: 'Skill toevoegen', onClick: () => { setAdding(true); setNotice(''); } }} />
          )
        ) : (
          <ul className="rounded-card border border-(--border) divide-y divide-(--border) overflow-hidden">
            {own.map((s) => (
              <li key={s.name} data-focus-id={s.name} className="px-4 py-3 bg-(--input) flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-[13px] text-(--text) break-all">{s.name}</span>
                  {s.shared && <span className="tr-line ml-2 align-middle text-[11px] px-1.5 py-0.5 rounded-full bg-(--accent)/10 text-(--accent)">gedeeld met iedereen</span>}
                  {s.description && <p className="text-sm text-(--muted) mt-1 line-clamp-3">{s.description}</p>}
                  {isAdmin && (
                    <label className="mt-2 inline-flex items-center gap-2 text-xs text-(--muted) cursor-pointer min-h-8">
                      <button type="button" role="switch" aria-checked={!!s.shared} aria-label={`${s.name} delen met iedereen`} disabled={sharing === s.name}
                        onClick={() => void share(s.name, !s.shared)} className="ll-switch disabled:opacity-50" />
                      Delen met iedereen
                    </label>
                  )}
                  {s.source && (
                    <a href={s.source} target="_blank" rel="noreferrer" className="inline-block mt-1 text-xs text-(--accent) hover:underline break-all">
                      {s.source.replace(/^https:\/\/github\.com\//, 'github.com/').replace(/\/tree\/HEAD/, '')}
                    </a>
                  )}
                </div>
                {s.source && (
                  <button onClick={() => void update(s.name, s.source!)} disabled={updating === s.name} title="Opnieuw ophalen van GitHub"
                    className="shrink-0 h-8 px-2.5 rounded-lg text-xs text-(--muted) hover:text-(--text) hover:bg-(--border)/40 transition-colors disabled:opacity-50">
                    {updating === s.name ? 'Bijwerken…' : 'Bijwerken'}
                  </button>
                )}
                <button onClick={() => void remove(s.name)} title="Verwijderen" aria-label={`${s.name} verwijderen`}
                  className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg text-(--muted) hover:text-red-400 hover:bg-red-500/10 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {byOthers.length > 0 && (
        <section className="mb-7">
          <h2 className="text-xs font-medium text-(--muted) mb-2 px-1">Gedeeld door anderen ({byOthers.length})</h2>
          <ul className="rounded-card border border-(--border) divide-y divide-(--border) overflow-hidden">
            {byOthers.map((s, i) => (
              <li key={s.name} style={{ '--i': Math.min(i, 8) } as React.CSSProperties} className="wa-row-in px-4 py-3 bg-(--input)">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                  <span className="font-mono text-[13px] text-(--text) break-all">{s.name}</span>
                  <span className="text-[11px] px-1.5 py-0.5 rounded-full bg-(--accent)/10 text-(--accent) shrink-0">Gedeeld door {s.owner}</span>
                </div>
                {s.description && <p className="text-sm text-(--muted) mt-1 line-clamp-3">{s.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {groups.length === 0 && q && <p className="text-sm text-(--muted) mb-7">Geen gedeelde skills gevonden voor &quot;{filter}&quot;.</p>}

      {groups.map(([source, list]) => (
        <section key={source} className="mb-7">
          <h2 className="text-xs font-medium text-(--muted) mb-2 px-1">{sourceLabel(source)} ({list.length})</h2>
          <ul className="rounded-card border border-(--border) divide-y divide-(--border) overflow-hidden">
            {list.map((s) => (
              <li key={s.folder} className="px-4 py-3 bg-(--input)">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[13px] text-(--text) break-all">{s.name}</span>
                  <span className="text-[11px] text-(--muted) shrink-0 tabular-nums">{s.sizeKB} KB</span>
                </div>
                {s.description && <p className="text-sm text-(--muted) mt-1 line-clamp-3">{s.description}</p>}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {data.hooks && data.hooks.length > 0 && (
        <section className="mb-7">
          <h2 className="text-xs font-medium text-(--muted) mb-2 px-1">Actieve hooks ({data.hooks.length})</h2>
          <ul className="rounded-card border border-(--border) divide-y divide-(--border) overflow-hidden">
            {data.hooks.map((h) => (
              <li key={h.plugin + h.event} className="px-4 py-3 bg-(--input)">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-mono text-[13px] text-(--text)">{sourceLabel('plugin:' + h.plugin)}</span>
                  <span className="text-[11px] text-(--muted) shrink-0">{h.event}</span>
                </div>
                <p className="text-sm text-(--muted) mt-1">{h.what}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
