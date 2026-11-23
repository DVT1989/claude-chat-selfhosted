'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { useTranslations } from '@/lib/i18n';
import { projectsApi } from '@/lib/api';
import { NavIcons } from '@/components/navItems';
import type { Project } from '@/types';

export const PROJECT_COLORS: Record<string, string> = {
  terracotta: '#D97757',
  amber: '#D99A2B',
  olive: '#7A8F3A',
  teal: '#1F9A8A',
  blue: '#3B82F6',
  violet: '#8B5CF6',
  rose: '#E0587A',
  slate: '#71717A',
};

export function projectColor(name: string | undefined): string {
  return PROJECT_COLORS[name ?? ''] ?? PROJECT_COLORS.terracotta;
}

/** Folder tile in the project's colour (list cards, project header, move menu) */
export function ProjectTile({ color, size = 40 }: { color: string; size?: number }) {
  return (
    <span aria-hidden className="proj-tile shrink-0" style={{ '--pc': projectColor(color), width: size, height: size } as React.CSSProperties}>
      {NavIcons.folder(size >= 40 ? 'w-5 h-5' : 'w-4 h-4')}
    </span>
  );
}

/**
 * New project (name + colour) and project settings (also instructions, delete).
 * Slides up as a sheet on phones and scales in as a dialog on desktop.
 */
export default function ProjectDialog({ project, onClose, onSaved, onDeleted }: {
  project: Project | null;
  onClose: () => void;
  onSaved: (p: Project) => void;
  onDeleted?: () => void;
}) {
  const t = useTranslations('conversations');
  const editing = !!project;
  const [name, setName] = useState(project?.name ?? '');
  const [color, setColor] = useState(project?.color ?? 'terracotta');
  const [instructions, setInstructions] = useState(project?.instructions ?? '');
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const r = requestAnimationFrame(() => setShown(true));
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', k);
    if (!editing) setTimeout(() => nameRef.current?.focus(), 120);
    return () => { cancelAnimationFrame(r); window.removeEventListener('keydown', k); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function close() {
    setShown(false);
    setTimeout(onClose, 220);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const res = editing
        ? await projectsApi.update(project!.id, { name: name.trim(), color, instructions })
        : await projectsApi.create({ name: name.trim(), color, instructions: instructions || undefined });
      onSaved(res.project);
      close();
    } catch { setBusy(false); }
  }

  async function remove() {
    if (!project || !confirm(t('confirmDeleteProject', { name: project.name }))) return;
    try { await projectsApi.delete(project.id); onDeleted?.(); close(); } catch { /* ignore */ }
  }

  return createPortal(
    <div className={clsx('pd-root', shown && 'pd-on')} role="dialog" aria-modal="true" aria-label={editing ? t('dialogEditTitle') : t('dialogNewTitle')}>
      <div className="pd-backdrop" onClick={close} />
      <form className="pd-sheet" onSubmit={(e) => void save(e)}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-(--text)">{editing ? t('dialogEditTitle') : t('dialogNewTitle')}</h2>
          <ProjectTile color={color} size={36} />
        </div>

        <label className="block mt-4">
          <span className="pd-label">{t('name')}</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
            placeholder={t('namePlaceholder')} className="pd-input" />
        </label>

        <div className="mt-4">
          <span className="pd-label">{t('color')}</span>
          <div className="flex flex-wrap gap-2.5 mt-1.5" role="radiogroup" aria-label={t('color')}>
            {Object.entries(PROJECT_COLORS).map(([key, hex]) => (
              <button key={key} type="button" role="radio" aria-checked={color === key} aria-label={t(`colors.${key}`)} title={t(`colors.${key}`)}
                onClick={() => setColor(key)} className={clsx('pd-dot', color === key && 'pd-dot-on')} style={{ '--pc': hex } as React.CSSProperties}>
                {NavIcons.check('w-4 h-4')}
              </button>
            ))}
          </div>
        </div>

        <label className="block mt-4">
          <span className="pd-label">{t('instructions')}</span>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={editing ? 7 : 4}
            placeholder={t('instructionsPlaceholder')} className="pd-input pd-area" />
          <span className="block mt-1 text-xs text-(--muted)">{t('instructionsHint')}</span>
        </label>

        <div className="flex items-center gap-2 mt-5">
          {editing && (
            <button type="button" onClick={() => void remove()} className="pd-btn pd-btn-danger mr-auto">
              {NavIcons.trash('w-4 h-4')}<span>{t('deleteProject')}</span>
            </button>
          )}
          <button type="button" onClick={close} className={clsx('pd-btn', !editing && 'ml-auto')}>{t('cancel')}</button>
          <button type="submit" disabled={!name.trim() || busy} className="pd-btn pd-btn-primary">{editing ? t('save') : t('create')}</button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
