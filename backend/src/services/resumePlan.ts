/**
 * Pure rules (tested) for continuing a conversation by itself after a backend restart.
 *
 * Two cases:
 * - interrupted: the answer was still running when the process died (any tool call included). At boot
 *   every message still flagged streaming is marked interrupted; those continue where they stopped.
 * - deploy-check: Claude started `selfupdate backend` and finished its answer before the helper
 *   restarted the backend (selfupdate only starts the build, the restart follows minutes later). Nothing
 *   was cut off, so before this the conversation waited for the user to type "verder". The restart
 *   notice now names the conversation; it gets a follow-up that checks the rollout.
 */

/** an answer that started longer ago than this is not continued (it was long abandoned) */
export const ORPHAN_WINDOW_MS = 6 * 3600_000;
/** a deploy check only follows an answer this recent */
export const DEPLOY_WINDOW_MS = 2 * 3600_000;
/** the selfupdate marker is only trusted this long (a failed build leaves no marker; an old one is ignored) */
export const DEPLOY_MARKER_MS = 30 * 60_000;
/** crash loop guard: at most this many automatic resumes per conversation per hour */
export const MAX_RESUMES_PER_HOUR = 3;

export const SELFUPDATE_RESUME_KEY = 'selfupdate:resume';

export interface LastMessage {
  role: string;
  metadata: { interrupted?: boolean; streaming?: boolean } | null;
  created_at: Date | string;
}

export type ResumeKind = 'interrupted' | 'deploy-check';

export function orphanResumable(createdAt: Date | string, now = Date.now()): boolean {
  return now - new Date(createdAt).getTime() < ORPHAN_WINDOW_MS;
}

export function resumePlan(last: LastMessage | undefined, opts: { deploy: boolean; recentResumes: number; now?: number }): ResumeKind | null {
  const now = opts.now ?? Date.now();
  if (!last || last.role !== 'assistant') return null; // the user said something after it: their message leads
  if (opts.recentResumes >= MAX_RESUMES_PER_HOUR) return null;
  if (last.metadata?.interrupted) return 'interrupted';
  if (opts.deploy && !last.metadata?.streaming && now - new Date(last.created_at).getTime() < DEPLOY_WINDOW_MS) return 'deploy-check';
  return null;
}

/** The selfupdate marker from the restart notice, when it is valid and recent. */
export function parseDeployMarker(raw: string | null, now = Date.now()): string | null {
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as { conversationId?: unknown; at?: unknown };
    if (typeof m.conversationId !== 'string' || !/^[0-9a-f-]{36}$/.test(m.conversationId)) return null;
    if (typeof m.at !== 'number' || now - m.at > DEPLOY_MARKER_MS) return null;
    return m.conversationId;
  } catch { return null; }
}

export const DEPLOY_CHECK_LINE = 'Je had zelf selfupdate backend gestart. Controleer nu zelf of de uitrol gelukt is (selfupdate --log, docker compose ps, zo nodig de logs) en meld het resultaat kort.';

export function resumeMessage(kind: ResumeKind, deploy: boolean): string {
  if (kind === 'deploy-check') {
    return `De backend is herstart door je selfupdate, dit gesprek gaat vanzelf verder. ${DEPLOY_CHECK_LINE} Herhaal niets wat je al hebt gezegd en ga daarna verder met wat nog open stond.`;
  }
  return 'De backend is herstart tijdens je vorige antwoord. Ga verder waar je was gebleven en herhaal niets wat je al hebt gezegd.'
    + (deploy ? ` ${DEPLOY_CHECK_LINE}` : '');
}
