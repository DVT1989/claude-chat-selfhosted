import { Router, Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { requireAuth } from '../middleware/auth';
import { query } from '../db';

const execFileP = promisify(execFile);

export const modelsRouter = Router();

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  category: 'alias' | 'full';
}

// Static aliases (stable, always offered)
const STATIC_ALIASES: ModelOption[] = [
  { id: 'sonnet',  label: 'Sonnet (latest)', description: 'Snel + slim. Goede balans.', category: 'alias' },
  { id: 'opus',    label: 'Opus (latest)',   description: 'Krachtigste model.', category: 'alias' },
  { id: 'haiku',   label: 'Haiku (latest)',  description: 'Snelst + goedkoopst.', category: 'alias' },
  { id: 'opusplan',label: 'Opus Plan',       description: 'Opus voor planning, Sonnet voor uitvoering.', category: 'alias' },
];

// Fallback full IDs (used if discovery hasn't run yet)
const FALLBACK_FULL: ModelOption[] = [
  { id: 'claude-opus-4-7',   label: 'Opus 4.7',   description: 'Specifieke versie.', category: 'full' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', description: 'Specifieke versie.', category: 'full' },
  { id: 'claude-haiku-4-5',  label: 'Haiku 4.5',  description: 'Specifieke versie.', category: 'full' },
];

export const DEFAULT_MODEL = 'sonnet';

// In-memory cache (populated from DB on first GET, refreshed by admin)
let cachedFullModels: ModelOption[] | null = null;

async function loadCacheFromDb(): Promise<ModelOption[] | null> {
  try {
    const r = await query<{ value: string }>(
      "SELECT value FROM system_config WHERE key = 'discovered_models'",
    );
    if (r.rows[0]?.value) {
      return JSON.parse(r.rows[0].value) as ModelOption[];
    }
  } catch { /* table may not exist yet */ }
  return null;
}

async function saveCacheToDb(models: ModelOption[]): Promise<void> {
  await query(
    `INSERT INTO system_config (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    ['discovered_models', JSON.stringify(models)],
  );
}

function formatLabel(modelId: string): string {
  // claude-opus-4-7 → "Opus 4.7"
  const m = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)$/);
  if (m) {
    const family = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    return `${family} ${m[2]}.${m[3]}`;
  }
  // claude-haiku-4-5-20251001 → "Haiku 4.5 (2025-10-01)"
  const dated = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)-(\d{4})(\d{2})(\d{2})$/);
  if (dated) {
    const family = dated[1].charAt(0).toUpperCase() + dated[1].slice(1);
    return `${family} ${dated[2]}.${dated[3]} (${dated[4]}-${dated[5]}-${dated[6]})`;
  }
  return modelId;
}

function modelSortKey(modelId: string): string {
  // Sort newest first: family then version desc
  const m = modelId.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/);
  if (m) {
    const familyOrder = { opus: '1', sonnet: '2', haiku: '3' }[m[1]] ?? '9';
    const major = String(99 - parseInt(m[2], 10)).padStart(2, '0');
    const minor = String(99 - parseInt(m[3], 10)).padStart(2, '0');
    return `${familyOrder}-${major}-${minor}-${modelId}`;
  }
  return `9-${modelId}`;
}

export async function discoverModelsFromCLI(): Promise<ModelOption[]> {
  // Resolve real path of the claude binary (follow symlink)
  const { stdout: realPath } = await execFileP('readlink', ['-f', '/usr/local/bin/claude']);
  const binPath = realPath.trim();

  // Extract strings, filter to canonical model IDs
  const { stdout } = await execFileP('sh', ['-c',
    `strings "${binPath}" | grep -oE 'claude-(opus|sonnet|haiku)-[0-9]+-[0-9]+(-[0-9]{8})?' | sort -u`,
  ], { maxBuffer: 4 * 1024 * 1024 });

  const seen = new Set<string>();
  const ids = stdout.split('\n').map(s => s.trim()).filter(s => {
    if (!s || seen.has(s)) return false;
    seen.add(s);
    return true;
  });

  // Prefer clean IDs (no date) over dated. Group by clean stem.
  // Keep both clean form + dated form when both exist.
  const cleanIds = ids.filter(id => /^claude-(opus|sonnet|haiku)-\d+-\d+$/.test(id));
  const datedIds = ids.filter(id => /^claude-(opus|sonnet|haiku)-\d+-\d+-\d{8}$/.test(id));

  const cleanList: ModelOption[] = cleanIds
    .sort((a, b) => modelSortKey(a).localeCompare(modelSortKey(b)))
    .map(id => ({
      id, label: formatLabel(id),
      description: 'Vast aan deze versie.',
      category: 'full' as const,
    }));

  // Add dated only if no clean variant exists for that stem
  const cleanStems = new Set(cleanIds);
  const datedList: ModelOption[] = datedIds
    .filter(id => {
      const stem = id.replace(/-\d{8}$/, '');
      return !cleanStems.has(stem);
    })
    .sort((a, b) => modelSortKey(a).localeCompare(modelSortKey(b)))
    .map(id => ({
      id, label: formatLabel(id),
      description: 'Vast aan deze datum.',
      category: 'full' as const,
    }));

  return [...cleanList, ...datedList];
}

export async function refreshModels(): Promise<ModelOption[]> {
  const discovered = await discoverModelsFromCLI();
  if (discovered.length > 0) {
    cachedFullModels = discovered;
    await saveCacheToDb(discovered);
  }
  return discovered;
}

// Keep the stored model list in step with the installed Claude Code CLI:
// once at startup and then every 24 hours. A failed run keeps the old list.
const MODEL_REFRESH_MS = 24 * 60 * 60 * 1000;

export function startModelRefresh(): void {
  const run = async () => {
    try {
      const found = await refreshModels();
      console.log(`✓ Model list refreshed (${found.length} models)`);
    } catch (err) {
      console.error('Model refresh failed:', (err as Error).message);
    }
  };
  void run();
  setInterval(run, MODEL_REFRESH_MS).unref();
}

async function getFullModels(): Promise<ModelOption[]> {
  if (cachedFullModels) return cachedFullModels;
  const fromDb = await loadCacheFromDb();
  if (fromDb && fromDb.length > 0) {
    cachedFullModels = fromDb;
    return fromDb;
  }
  return FALLBACK_FULL;
}

modelsRouter.get('/', requireAuth, async (_req: Request, res: Response) => {
  const fullModels = await getFullModels();
  res.json({
    models: [...STATIC_ALIASES, ...fullModels],
    default: DEFAULT_MODEL,
  });
});
