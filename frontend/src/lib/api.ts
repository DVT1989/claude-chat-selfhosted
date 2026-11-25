// All API calls go to /api/* — nginx proxies to backend
const BASE = '/api';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Session gone (revoked, expired, TOTP changed): go to the login page instead of a half-working app.
// Watches every fetch to /api, also from components with their own helper.
const SESSION_ERRORS = new Set(['Session expired', 'Invalid token', 'Authentication required']);
let leaving = false;
export function toLogin(reason = 'verlopen'): void {
  if (typeof window === 'undefined' || leaving || window.location.pathname.startsWith('/login')) return;
  leaving = true;
  const from = window.location.pathname + window.location.search;
  window.location.href = `/login?reden=${reason}&from=${encodeURIComponent(from)}`;
}
if (typeof window !== 'undefined' && !(window as unknown as { __ccAuthWatch?: boolean }).__ccAuthWatch) {
  (window as unknown as { __ccAuthWatch?: boolean }).__ccAuthWatch = true;
  const orig = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await orig(input, init);
    if (res.status === 401) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/api/') && !url.includes('/auth/login')) {
        res.clone().json().then((j: { error?: string }) => { if (j?.error && SESSION_ERRORS.has(j.error)) toLogin(); }).catch(() => {});
      }
    }
    return res;
  };
}

async function request<T>(
  path: string,
  init?: RequestInit,
  attempt = 0,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  } catch (e) {
    // network gone for a moment (backend restart): retry reads a few times
    if (isRead(init) && attempt < 8) { await sleep(2500); return request<T>(path, init, attempt + 1); }
    throw e;
  }

  // backend restarting (nginx 502/503/504): reads wait and retry for ~20 s instead of failing
  if ((res.status === 502 || res.status === 503 || res.status === 504) && isRead(init) && attempt < 8) {
    await sleep(2500);
    return request<T>(path, init, attempt + 1);
  }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    let bodyData: Record<string, unknown> = {};
    try {
      bodyData = await res.json() as Record<string, unknown>;
      if (typeof bodyData.error === 'string') msg = bodyData.error;
      else if (res.status === 502 || res.status === 503 || res.status === 504) msg = 'De server start even opnieuw. Probeer het zo nog eens.';
    } catch { /* ignore */ }
    const err = new Error(msg) as Error & { data?: Record<string, unknown>; status?: number };
    err.data = bodyData;
    err.status = res.status;
    throw err;
  }

  if (res.status === 204) return null as T;
  try {
    return await res.json() as T;
  } catch {
    // not JSON (e.g. an HTML error page during a restart): a readable error instead of a parse error
    const err = new Error('De server start even opnieuw. Probeer het zo nog eens.') as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
}

function isRead(init?: RequestInit): boolean {
  const m = (init?.method ?? 'GET').toUpperCase();
  return m === 'GET' || m === 'HEAD';
}

// ── Auth ──────────────────────────────────────────────────────
export const i18nApi = {
  languages: () => request<{ languages: { code: string; name: string }[] }>('/i18n/languages', { cache: 'no-store' }),
  generate: (language: string) => request<{ jobId: string }>('/i18n/generate', { method: 'POST', body: JSON.stringify({ language }) }),
  job: (id: string) => request<{ status: 'running' | 'done' | 'error'; done: number; total: number; code?: string; name?: string; error?: string; fallbackKeys: number }>(`/i18n/jobs/${id}`, { cache: 'no-store' }),
};

export const auth = {
  login: (email: string, password: string, totp_code?: string, remember = true) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, remember, ...(totp_code ? { totp_code } : {}) }) }),

  register: (email: string, password: string, name?: string) =>
    request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),

  logout: () =>
    request('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: import('@/types').User }>('/auth/me', { cache: 'no-store' }),

  updateProfile: (data: { name?: string; password?: string; currentPassword?: string; language?: string; avatar?: string | null; theme?: string; default_model?: string | null; theme_mode?: 'light' | 'dark' | 'system'; accent_color?: string; preferences?: { spellcheck?: boolean; spell_lang?: 'nl' | 'en' | 'auto'; bg_motion?: boolean; remote_notice?: boolean; prompt_suggestions?: boolean; render_hosts?: string } }) =>
    request<{ ok: boolean; user?: import('@/types').User }>('/auth/me', { method: 'PUT', body: JSON.stringify(data) }),
};

// ── Projects ──────────────────────────────────────────────────
export const projectsApi = {
  list: () => request<{ projects: import('@/types').Project[] }>('/projects'),
  create: (data: { name: string; color?: string; instructions?: string }) =>
    request<{ project: import('@/types').Project }>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: Partial<{ name: string; color: string; instructions: string }>) =>
    request<{ project: import('@/types').Project }>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  delete: (id: string) => request(`/projects/${id}`, { method: 'DELETE' }),
  members: (id: string) => request<{ members: import('@/types').ProjectMember[] }>(`/projects/${id}/members`),
  candidates: (id: string, q: string) =>
    request<{ users: Array<{ id: string; name: string; avatar: string | null; email?: string }> }>(`/projects/${id}/candidates?q=${encodeURIComponent(q)}`),
  addMember: (id: string, userId: string) => request(`/projects/${id}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
  removeMember: (id: string, userId: string) => request(`/projects/${id}/members/${userId}`, { method: 'DELETE' }),
  connectors: (id: string) => request<{ connectors: Array<{ id: string; name: string; type: string; shared: boolean; mine?: boolean; by?: string | null }> }>(`/projects/${id}/connectors`),
  setConnectors: (id: string, connectorIds: string[]) => request(`/projects/${id}/connectors`, { method: 'PUT', body: JSON.stringify({ connectorIds }) }),
  setColor: (id: string, userId: string, color: string) =>
    request<{ members: import('@/types').ProjectMember[]; palette: string[] }>(`/projects/${id}/members/${userId}/color`, { method: 'PUT', body: JSON.stringify({ color }) }),
  agents: (id: string) => request<{ agents: import('@/types').ProjectAgent[]; can_edit: boolean; me: string }>(`/projects/${id}/agents`),
  setAgent: (id: string, agentId: string, b: { inProject: boolean; userIds: string[]; accountMode?: 'user' | 'owner'; fallback?: boolean }) =>
    request<{ agents: import('@/types').ProjectAgent[] }>(`/projects/${id}/agents/${agentId}`, { method: 'PUT', body: JSON.stringify(b) }),
  setAgentAccount: (id: string, agentId: string, b: { accountMode: 'user' | 'owner'; fallback: boolean }) =>
    request<{ agents: import('@/types').ProjectAgent[] }>(`/projects/${id}/agents/${agentId}/account`, { method: 'PUT', body: JSON.stringify(b) }),
  memory: (id: string) => request<{ memories: import('@/types').ProjectMemoryItem[] }>(`/projects/${id}/memory`),
  addMemory: (id: string, b: { content: string; topic?: string; pinned?: boolean }) =>
    request<{ memories: import('@/types').ProjectMemoryItem[] }>(`/projects/${id}/memory`, { method: 'POST', body: JSON.stringify(b) }),
  updateMemory: (id: string, mid: string, b: Partial<{ content: string; topic: string; pinned: boolean }>) =>
    request<{ memories: import('@/types').ProjectMemoryItem[] }>(`/projects/${id}/memory/${mid}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteMemory: (id: string, mid: string) =>
    request<{ memories: import('@/types').ProjectMemoryItem[] }>(`/projects/${id}/memory/${mid}`, { method: 'DELETE' }),
  events: (id: string, before?: string) =>
    request<{ events: import('@/types').ProjectEvent[]; next: string | null }>(`/projects/${id}/events?limit=30${before ? `&before=${before}` : ''}`),
  unread: () => request<{ unread: Record<string, number> }>('/projects/unread'),
  markRead: (convId: string) => request(`/projects/read/${convId}`, { method: 'POST' }),
  typing: (convId: string) => request(`/conversations/${convId}/typing`, { method: 'POST' }),
};

// ── Conversations ─────────────────────────────────────────────
export const conversations = {
  list: (limit = 50, offset = 0) =>
    request<{ conversations: import('@/types').Conversation[] }>(`/conversations?limit=${limit}&offset=${offset}`),

  get: (id: string) =>
    request<import('@/types').ConversationDetail & { conversation: import('@/types').Conversation }>(`/conversations/${id}`),

  create: (data: { title?: string; model?: string; connectorIds?: string[]; deviceId?: string; projectId?: string }) =>
    request<{ conversation: import('@/types').Conversation }>('/conversations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<{ title: string; model: string; status: string; connectorIds: string[]; projectId: string | null }>) =>
    request(`/conversations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (id: string) =>
    request(`/conversations/${id}`, { method: 'DELETE' }),

  export: (id: string) =>
    fetch(`${BASE}/conversations/${id}/export`, { credentials: 'include' }),

  import: (data: unknown) =>
    request<{ conversationId: string }>('/conversations/import', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getScheduledResume: (id: string) =>
    request<{ scheduledFor: string | null; agents?: string[]; agentsOnly?: boolean }>(`/conversations/${id}/schedule-resume`),

  scheduleResume: (id: string, message: string, scheduledFor: string) =>
    request<{ ok: boolean; scheduledFor: string }>(`/conversations/${id}/schedule-resume`, {
      method: 'POST',
      body: JSON.stringify({ message, scheduledFor }),
    }),

  cancelScheduledResume: (id: string) =>
    request<{ ok: boolean }>(`/conversations/${id}/schedule-resume`, { method: 'DELETE' }),

  getPush: (id: string) => request<{ on: boolean }>(`/conversations/${id}/push`),
  setPush: (id: string, on: boolean) =>
    request<{ on: boolean }>(`/conversations/${id}/push`, { method: 'PUT', body: JSON.stringify({ on }) }),

  // Stop the running answer on the server (not just this window's connection)
  stop: (id: string) => request<{ stopped: boolean }>(`/conversations/${id}/stream/stop`, { method: 'POST' }),
  queue: (id: string) => request<{ items: QueuedMessage[] }>(`/conversations/${id}/queue`),
  enqueue: (id: string, message: string, attachments: string[] = []) =>
    request<{ items: QueuedMessage[] }>(`/conversations/${id}/queue`, { method: 'POST', body: JSON.stringify({ message, attachments }) }),
  dequeue: (id: string, qid: string) =>
    request<{ items: QueuedMessage[] }>(`/conversations/${id}/queue/${qid}`, { method: 'DELETE' }),
  sendNow: (id: string, qid: string) =>
    request<{ items: QueuedMessage[] }>(`/conversations/${id}/queue/${qid}/now`, { method: 'POST' }),
};

export interface QueuedMessage { id: string; content: string; created_at: string; attachment_ids?: string[] }

// ── Claude Code OAuth ─────────────────────────────────────────
/** Chat account choice: automatic switching over all (slots null) or chosen accounts, or one fixed account. */
export interface AccountSwitch { auto: boolean; slots: number[] | null; fixed: number }

export interface ClaudeAccountInfo {
  slot: number; email: string | null; plan: string | null;
  usage: { session: UsageWindow | null; weekly: UsageWindow | null } | null;
  limited: boolean; active: boolean; inUse?: boolean;
  /** when this account can take a message again; null when it has room now */
  usableAt: string | null;
}

export const claudeAuth = {
  /** newAccount: link an extra Claude subscription instead of (re)linking account 1 */
  start: (newAccount = false) =>
    request<{ url: string; slot: number }>('/claude-auth/start', { method: 'POST', body: JSON.stringify({ newAccount }) }),

  accounts: () =>
    request<{ accounts: ClaudeAccountInfo[] }>('/claude-auth/accounts'),

  switching: () =>
    request<AccountSwitch>('/claude-auth/switching'),

  setSwitching: (v: AccountSwitch) =>
    request<AccountSwitch>('/claude-auth/switching', { method: 'PUT', body: JSON.stringify(v) }),

  removeAccount: (slot: number) =>
    request<{ ok: true }>(`/claude-auth/accounts/${slot}`, { method: 'DELETE' }),

  status: () =>
    request<{ status: 'authenticated' | 'not_configured' | 'error' }>('/claude-auth/status'),

  submitCode: (code: string) =>
    request('/claude-auth/submit-code', { method: 'POST', body: JSON.stringify({ code }) }),

  logout: () =>
    request('/claude-auth', { method: 'DELETE' }),
};

// ── Admin ─────────────────────────────────────────────────────
export interface UpdateCommit { sha: string; subject: string; date: string }
export interface AppUpdateStatus {
  available: boolean; reason: string | null; repo: string | null; branch: string | null;
  current: UpdateCommit | null; latest: UpdateCommit | null; behind: number; ahead: number; dirty: number;
  incoming: UpdateCommit[]; services: string[]; updating: boolean; checkedAt: string;
  phase?: string | null; lastError?: string | null;
}

export const admin = {
  updateStatus: () => request<AppUpdateStatus>('/admin/update'),
  runUpdate: () => request<{ message: string; services: string[] }>('/admin/update', { method: 'POST' }),
  getStats: () =>
    request<{ users: number; conversations: number; messages: number; totalTokens: number }>('/admin/stats'),

  listUsers: () =>
    request<{ users: { id: string; email: string; name: string | null; role: string; is_active: boolean; conversation_count: string }[] }>('/admin/users'),

  updateUser: (id: string, data: { role?: 'user' | 'admin'; isActive?: boolean; password?: string }) =>
    request(`/admin/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  createUser: (data: { username: string; name: string; password: string; role: 'user' | 'admin' }) =>
    request<{ user: { id: string; email: string; name: string; role: string } }>('/admin/users', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteUser: (id: string) =>
    request(`/admin/users/${id}`, { method: 'DELETE' }),

  getSystemConversation: () =>
    request<{
      conversationId: string;
      isNew: boolean;
      claudeAuthStatus: 'authenticated' | 'not_configured' | 'error';
      messages: import('@/types').Message[];
    }>('/admin/system/conversation'),

  getLogs: (limit = 100, offset = 0) =>
    request<{ logs: import('@/types').AuditLog[] }>(`/admin/logs?limit=${limit}&offset=${offset}`),

  listSessions: (userId: string) =>
    request<{ sessions: import('@/types').AdminSession[] }>(`/admin/users/${userId}/sessions`),

  revokeSessions: (userId: string) =>
    request<{ revoked: number }>(`/admin/users/${userId}/sessions`, { method: 'DELETE' }),
};

export const backups = {
  list: () =>
    request<{ backups: { name: string; createdAt: string; status: string; sizeBytes?: number }[] }>('/admin/backups'),
  create: () =>
    request<{ name: string; createdAt: string; status: string }>('/admin/backups/now', { method: 'POST' }),
  delete: (name: string) =>
    request<{ ok: boolean }>(`/admin/backups/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  restore: (name: string) =>
    request<{ ok: boolean }>(`/admin/backups/${encodeURIComponent(name)}/restore`, { method: 'POST' }),
  downloadUrl: (name: string) =>
    `/api/admin/backups/${encodeURIComponent(name)}/download`,
};

export interface UsageWindow { pct: number; resetAt: string | null }
/** stale: the latest fetch failed or is old; this is the last good reading, taken at fetchedAt */
export interface AnthropicUsage { session: UsageWindow | null; weekly: UsageWindow | null; stale?: boolean; fetchedAt?: string }

// ── Usage ─────────────────────────────────────────────────────
export const usage = {
  /** fresh: right after an answer, ask the backend to fetch the subscription usage now */
  get: (fresh = false) =>
    request<{
      weekTokens: number;
      todayTokens: number;
      weekMessages: number;
      todayMessages: number;
      weekCostUsd: number;
      todayCostUsd: number;
      rateLimitTier: string | null;
      anthropic: AnthropicUsage | null;
      accounts?: ClaudeAccountInfo[];
    }>(fresh ? '/usage?fresh=1' : '/usage'),
};

// ── Connectors ────────────────────────────────────────────────
export const connectors = {
  list: () =>
    request<{ connectors: import('@/types').Connector[] }>('/connectors'),

  create: (data: { name: string; type: string; config?: Record<string, unknown>; credentials?: Record<string, unknown> }) =>
    request('/connectors', { method: 'POST', body: JSON.stringify(data) }),

  update: (id: string, data: { name?: string; config?: Record<string, unknown>; credentials?: Record<string, unknown>; isActive?: boolean }) =>
    request(`/connectors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  delete: (id: string) =>
    request(`/connectors/${id}`, { method: 'DELETE' }),

  test: (id: string) =>
    request<{ ok: boolean; message: string }>(`/connectors/${id}/test`, { method: 'POST' }),
};

// ── Google Search Console (OAuth) ─────────────────────────────
export const googleSc = {
  status: () => request<{ configured: boolean; clientId: string | null; isAdmin: boolean; redirectUri: string; scope: string }>('/connectors/google/status'),
  login: () => request<{ url: string }>('/connectors/google/login', { method: 'POST' }),
  saveConfig: (clientId: string, clientSecret: string) =>
    request<{ ok: boolean }>('/connectors/google/config', { method: 'PUT', body: JSON.stringify({ clientId, clientSecret }) }),
  clearConfig: () => request<{ ok: boolean }>('/connectors/google/config', { method: 'DELETE' }),
  setupPrompt: () => request<{ prompt: string; browsers: number }>('/connectors/google/setup-prompt'),
};

// ── Attachments ───────────────────────────────────────────────
export const attachments = {
  list: (conversationId: string) =>
    request<import('@/types').Attachment[]>(`/conversations/${conversationId}/attachments`),

  upload: (conversationId: string, file: File): Promise<import('@/types').Attachment> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1];
          const result = await request<import('@/types').Attachment>(
            `/conversations/${conversationId}/attachments`,
            { method: 'POST', body: JSON.stringify({ fileName: file.name, mimeType: file.type || 'application/octet-stream', data: base64 }) }
          );
          resolve(result);
        } catch (e) { reject(e); }
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    }),

  delete: (conversationId: string, attachmentId: string) =>
    request(`/conversations/${conversationId}/attachments/${attachmentId}`, { method: 'DELETE' }),
};

export const models = {
  list: () =>
    request<{ models: import('@/types').ModelOption[]; default: string }>('/models'),
  refresh: () =>
    request<{ ok: boolean; count: number; models: import('@/types').ModelOption[] }>('/admin/models/refresh', { method: 'POST' }),
};

export const totp = {
  setup: () => request<{ secret: string; otpauthUrl: string; qrDataUrl: string }>('/auth/totp/setup', { method: 'POST' }),
  enable: (code: string) => request<{ ok: boolean }>('/auth/totp/enable', { method: 'POST', body: JSON.stringify({ code }) }),
  disable: (password: string) => request<{ ok: boolean }>('/auth/totp/disable', { method: 'POST', body: JSON.stringify({ password }) }),
  cancelSetup: () => request<{ ok: boolean }>('/auth/totp/cancel-setup', { method: 'POST' }),
};


export const push = {
  vapidKey: () => request<{ key: string }>('/push/vapid-public-key'),
  status: () => request<{ enabled: boolean }>('/push/status'),
  subscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ ok: boolean }>('/push/subscribe', { method: 'POST', body: JSON.stringify(sub) }),
  unsubscribe: (endpoint: string) =>
    request<{ ok: boolean }>('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  test: () => request<{ ok: boolean }>('/push/test', { method: 'POST' }),
  presence: (clientId: string, visible: boolean, endpoint: string | null = null) =>
    request<{ ok: boolean }>('/push/presence', { method: 'POST', keepalive: true, body: JSON.stringify({ clientId, visible, endpoint }) }),
};

export interface SkillEntry {
  name: string;
  folder: string;
  source: string;
  description: string;
  sizeKB: number;
}
export interface SkillsManifest {
  generatedAt: string | null;
  generatedOn: string | null;
  skills: SkillEntry[];
  hooks?: { plugin: string; event: string; what: string }[];
  /** The signed-in user's own skills (~/.claude/skills/<name>/SKILL.md) */
  own?: { name: string; description: string; sizeKB: number; updatedAt: string; source?: string; shared?: boolean; share?: { visibility: 'private' | 'selected' | 'all'; users: string[]; groups: string[] } }[];
  /** Skills admins share with everyone (read-only) */
  sharedByOthers?: { name: string; description: string; owner: string; sizeKB: number; updatedAt: string }[];
}
export type SkillImportResult = { imported: { name: string; source: string }[]; skipped: { path: string; reason: string }[] };
export type NewSkill = { name?: string; description?: string; instructions?: string; skillMd?: string };
export const skills = {
  list: () => request<SkillsManifest>('/skills'),
  add: (data: NewSkill) => request<{ ok: true; name: string }>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  importGithub: (url: string) => request<SkillImportResult>('/skills/github', { method: 'POST', body: JSON.stringify({ url }) }),
  upload: async (file: File): Promise<SkillImportResult> => {
    const res = await fetch(`${BASE}/skills/upload?filename=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const j = await res.json().catch(() => ({})) as SkillImportResult & { error?: string };
    if (!res.ok) throw new Error(j.error || `Upload mislukt (HTTP ${res.status})`);
    return j;
  },
  remove: (name: string) => request<{ ok: true }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  share: (name: string, visibility: 'private' | 'selected' | 'all', users: string[] = [], groups: string[] = []) => request<{ ok: true; shared: boolean }>(`/skills/${encodeURIComponent(name)}/share`, { method: 'PUT', body: JSON.stringify({ visibility, users, groups }) }),
};

// ── Telegram ─────────────────────────────────────────────────
export interface TelegramStatus {
  enabled: boolean;
  hasToken: boolean;
  botUsername: string | null;
  paired: boolean;
  chatName: string | null;
  status: string;
  statusMessage: string | null;
  pairCodeExpires: string | null;
  /** Own bot name/avatar (data URL or path); null for users who have not set any. */
  botName: string | null;
  botAvatar: string | null;
}


export const telegram = {
  status: () => request<TelegramStatus>('/telegram'),
  save: (body: { enabled?: boolean; botToken?: string; botName?: string; botAvatar?: string }) =>
    request<TelegramStatus>('/telegram', { method: 'PUT', body: JSON.stringify(body) }),
  unpair: () => request<TelegramStatus>('/telegram/pairing', { method: 'DELETE' }),
  pairCode: () => request<{ code: string; expiresAt: string; link: string | null }>('/telegram/pair-code', { method: 'POST' }),
};

// ── Telegram agent bots ──────────────────────────────────────
export interface AgentBotChatter {
  id: string; name: string; username: string | null; status: 'pending' | 'approved' | 'denied' | 'revoked'; isOwner: boolean;
  conversationId: string | null; requestedAt: string; decidedAt: string | null; lastActive: string | null;
}
export interface AgentBot {
  id: string; name: string; botUsername: string | null; enabled: boolean; ratePerHour: number;
  status: string; statusMessage: string | null; agentIds: string[]; chatters: AgentBotChatter[];
  avatar: string | null; optCommands: boolean; optFull: boolean; optMessenger: boolean;
  invite: { link: string; expiresAt: string } | null;
}
export type AgentBotUpdate = {
  name?: string; botToken?: string; enabled?: boolean; agentIds?: string[]; ratePerHour?: number;
  avatar?: string; optCommands?: boolean; optFull?: boolean; optMessenger?: boolean;
};
export interface AgentBotOverview {
  agents: Array<{ id: string; name: string; color: string; avatar: string | null; shared_by: string | null; is_active: boolean }>;
  bots: AgentBot[];
}
export const telegramBots = {
  list: () => request<AgentBotOverview>('/telegram-bots'),
  create: (b: { name: string; botToken: string; agentIds: string[]; ratePerHour: number }) =>
    request<AgentBotOverview>('/telegram-bots', { method: 'POST', body: JSON.stringify(b) }),
  update: (id: string, b: AgentBotUpdate) =>
    request<AgentBotOverview>(`/telegram-bots/${id}`, { method: 'PUT', body: JSON.stringify(b) }),
  code: (id: string, kind: 'owner' | 'invite') =>
    request<{ code: string; expiresAt: string; link: string | null }>(`/telegram-bots/${id}/code`, { method: 'POST', body: JSON.stringify({ kind }) }),
  remove: (id: string) => request<AgentBotOverview>(`/telegram-bots/${id}`, { method: 'DELETE' }),
  decide: (id: string, chatterId: string, action: 'approve' | 'deny' | 'revoke') =>
    request<AgentBotOverview>(`/telegram-bots/${id}/chatters/${chatterId}`, { method: 'PUT', body: JSON.stringify({ action }) }),
};

// ── WhatsApp ─────────────────────────────────────────────────
export interface WhatsAppStatus {
  enabled: boolean;
  linked: boolean;
  phone: string | null;
  name: string | null;
  status: string;
  statusMessage: string | null;
  /** data: URL of the current QR code while waiting for a scan */
  qr: string | null;
  /** synced address book: numbers known, of which with a saved name */
  contacts: { total: number; named: number };
}

export const whatsapp = {
  status: () => request<WhatsAppStatus>('/whatsapp'),
  save: (body: { enabled?: boolean }) =>
    request<WhatsAppStatus>('/whatsapp', { method: 'PUT', body: JSON.stringify(body) }),
  unlink: () => request<WhatsAppStatus>('/whatsapp/link', { method: 'DELETE' }),
  syncContacts: () => request<WhatsAppStatus>('/whatsapp/contacts/sync', { method: 'POST' }),
};

// ── Telegram + WhatsApp together ─────────────────────────────
export interface MessengerSettings {
  claudeTelegram: boolean;
  claudeWhatsapp: boolean;
  relayTelegram: boolean;
  relayWhatsapp: boolean;
  mirrorTelegram: boolean;
  mirrorWhatsapp: boolean;
  syncActive: boolean;
  contactsWhatsapp: boolean;
  /** max. different recipients per hour for contactsWhatsapp; 0 = unlimited */
  recipientsPerHour: number;
}
export interface MessengerChannelState { channel: 'telegram' | 'whatsapp'; ready: boolean; reason: string | null }
export interface MessengerStatus { settings: MessengerSettings; channels: MessengerChannelState[] }

export const messenger = {
  status: () => request<MessengerStatus>('/messenger'),
  save: (body: Partial<MessengerSettings>) =>
    request<MessengerStatus>('/messenger', { method: 'PUT', body: JSON.stringify(body) }),
};

// ── Personal agents (per user) ────────────────────────────────
export interface AgentDef {
  id: string; name: string; slug: string; description: string; prompt: string;
  model: string; avatar: string | null; color: string; is_active: boolean; created_at: string;
  knowledge?: string | null; trained_at?: string | null; trained_conversations?: number;
  /** Claude accounts (slots) for this agent's own runs; null = all accounts */
  account_slots?: number[] | null;
  /** Sharing by an admin; owner_id/shared_by tell whether this agent is shared with you (read-only) */
  visibility?: 'private' | 'selected' | 'all';
  share_users?: string[]; share_groups?: string[];
  owner_id?: string;
  /** Connectors this agent may use (own agents only) */
  connector_ids?: string[];
  shared_by?: string | null;
  /** Whose Claude account runs a shared agent: the user's own or the owner's subscription */
  share_account?: 'user' | 'owner';
  share_fallback?: boolean;
  /** Recipients only, with share_account owner: is the owner's account full (no usage figures) */
  owner_account_state?: { full: boolean; usableAt?: string };
}
export type AgentInput = Omit<AgentDef, 'share_account' | 'share_fallback' | 'owner_account_state' | 'id' | 'slug' | 'created_at' | 'knowledge' | 'trained_at' | 'trained_conversations' | 'visibility' | 'share_users' | 'share_groups' | 'owner_id' | 'shared_by' | 'connector_ids'>;
export interface UserGroup { id: string; name: string; members: string[] }
export interface ShareTargets { users: { id: string; name: string }[]; groups: { id: string; name: string }[] }
export const groupsApi = {
  list: () => request<{ groups: UserGroup[]; users: { id: string; name: string }[] }>('/groups'),
  create: (name: string, members: string[]) => request<{ groups: UserGroup[] }>('/groups', { method: 'POST', body: JSON.stringify({ name, members }) }),
  update: (id: string, name: string, members: string[]) => request<{ groups: UserGroup[] }>(`/groups/${id}`, { method: 'PUT', body: JSON.stringify({ name, members }) }),
  remove: (id: string) => request<{ groups: UserGroup[] }>(`/groups/${id}`, { method: 'DELETE' }),
};
export interface AgentTraining {
  state: 'geen' | 'wachten' | 'bezig' | 'klaar' | 'fout'; done: number; total: number; waiting: string | null; error: string | null;
  knowledge: string | null; trained_at: string | null; trained_conversations: number; can_revert: boolean;
}
export const agentsApi = {
  list: () => request<{ agents: AgentDef[] }>('/agents'),
  create: (a: AgentInput) => request<{ agents: AgentDef[] }>('/agents', { method: 'POST', body: JSON.stringify(a) }),
  update: (id: string, a: AgentInput) => request<{ agents: AgentDef[] }>(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(a) }),
  remove: (id: string) => request<{ agents: AgentDef[] }>(`/agents/${id}`, { method: 'DELETE' }),
  train: (id: string) => request<AgentTraining>(`/agents/${id}/train`, { method: 'POST' }),
  trainStatus: (id: string) => request<AgentTraining>(`/agents/${id}/train`),
  setKnowledge: (id: string, knowledge: string) => request<AgentTraining>(`/agents/${id}/knowledge`, { method: 'PATCH', body: JSON.stringify({ knowledge }) }),
  shareTargets: () => request<ShareTargets>('/agents/share-targets'),
  share: (id: string, visibility: 'private' | 'selected' | 'all', users: string[], groups: string[], opts: { account_mode?: 'user' | 'owner'; fallback?: boolean } = {}) =>
    request<{ agents: AgentDef[] }>(`/agents/${id}/share`, { method: 'PUT', body: JSON.stringify({ visibility, users, groups, ...opts }) }),
  myConnectors: () => request<{ connectors: { id: string; name: string; type: string }[] }>('/agents/my-connectors'),
  setConnectors: (id: string, connector_ids: string[]) => request<{ agents: AgentDef[] }>(`/agents/${id}/connectors`, { method: 'PUT', body: JSON.stringify({ connector_ids }) }),
  setMine: (id: string, is_active: boolean) => request<{ agents: AgentDef[] }>(`/agents/${id}/mine`, { method: 'PUT', body: JSON.stringify({ is_active }) }),
  revertKnowledge: (id: string) => request<AgentTraining>(`/agents/${id}/knowledge/revert`, { method: 'POST' }),
};

// ── Delegations: an agent working in its own workplace (card in the parent conversation) ──
export type DelegationStatus = 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
export interface DelegationView {
  id: string; title: string; status: DelegationStatus; summary: string | null; error: string | null;
  conversationId: string; parentConversationId: string | null;
  agent: { id: string | null; name: string; slug: string | null; color: string | null };
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  live: { step: { tool: string; detail: string; at: number } | null; steps: number; runStartedAt: number;
    /** the agent at work right now (null while the main run works; absent on an older backend) */
    active?: DelegationCrewMember | null } | null;
  /** interrupted: reason and planned resume time (limit reset) */
  wait?: { reason: 'limit' | 'restart' | 'other'; resumeAt?: string };
  position?: number;
  /** agents that worked in the workplace, the delegated one first (absent on an older backend) */
  crew?: DelegationCrewMember[];
}
export interface DelegationCrewMember { id: string | null; name: string }
export const delegationsApi = {
  get: (id: string) => request<{ delegation: DelegationView }>(`/agents/delegations/${id}`),
  list: (parent: string) => request<{ delegations: DelegationView[] }>(`/agents/delegations?parent=${encodeURIComponent(parent)}`),
};

export interface AssistQuestion { id: string; question: string; why: string; multi: boolean; options: Array<{ label: string; detail: string }> }
export interface AssistDraft { name: string; color: string; description: string; prompt: string; model: 'haiku' | 'sonnet' | 'opus'; model_reason: string; summary: string }
export const agentAssist = (body: {
  idea: string; current?: { name: string; description: string; prompt: string; model: string } | null;
  answers: Array<{ question: string; answer: string }>; round: number;
}) => request<{ summary?: string; questions: AssistQuestion[]; draft?: AssistDraft }>('/agents/assist', { method: 'POST', body: JSON.stringify(body) });

// ── Scheduled tasks (Assistent > Taken) ──
export type TaskStatus = 'bezig' | 'wachtrij' | 'gelukt' | 'mislukt' | 'opgeschoven' | 'overgeslagen';
export interface TaskDef {
  id: string; name: string; prompt: string; agent_id: string | null;
  cron: string | null; schedule_text: string; run_at: string | null; timezone: string;
  enabled: boolean; autonomous: boolean; conversation_id: string | null;
  next_run_at: string | null; last_run_at: string | null; last_status: TaskStatus | null; last_summary: string | null;
  source_pattern: string | null; created_at: string; next_runs: string[];
}
export interface TaskInput {
  name: string; prompt: string; agent_id?: string | null;
  cron?: string | null; schedule_text?: string; run_at?: string | null; timezone?: string;
  enabled?: boolean; autonomous?: boolean; source_pattern?: string | null;
  new_agent?: { name: string; description: string; prompt: string; color: string };
}
export interface TaskSuggestion { key: string; summary: string; count: number; cron: string; schedule_text: string; reason: string }
export interface TaskAssist {
  name: string; prompt: string;
  has_schedule: boolean; cron: string; schedule_text: string; run_at: string;
  advice: 'bestaand' | 'nieuw' | 'los'; agent_slug: string; advice_reason: string; agent_id: string | null;
  new_agent: { name: string; description: string; prompt: string; color: string };
  next_runs: string[];
}
export interface TaskRunResult { status: TaskStatus; message: string; conversationId?: string }
type TaskList = { tasks: TaskDef[]; suggestions: TaskSuggestion[] };
export const tasksApi = {
  list: () => request<TaskList>('/tasks'),
  create: (t: TaskInput) => request<TaskList & { task: TaskDef }>('/tasks', { method: 'POST', body: JSON.stringify(t) }),
  update: (id: string, t: Partial<TaskInput>) => request<TaskList & { task: TaskDef }>(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(t) }),
  remove: (id: string) => request<TaskList>(`/tasks/${id}`, { method: 'DELETE' }),
  run: (id: string) => request<TaskList & { result: TaskRunResult }>(`/tasks/${id}/run`, { method: 'POST' }),
  execute: (id: string) => request<{ result: TaskRunResult }>(`/tasks/${id}/execute`, { method: 'POST' }),
  assist: (text: string) => request<TaskAssist>('/tasks/assist', { method: 'POST', body: JSON.stringify({ text }) }),
  preview: (cron: string) => request<{ schedule_text: string; next_runs: string[] }>('/tasks/preview', { method: 'POST', body: JSON.stringify({ cron }) }),
  dismissSuggestion: (key: string) => request<TaskList>(`/tasks/suggestions/${encodeURIComponent(key)}/dismiss`, { method: 'POST' }),
};

// ── Proposals of Coach (Assistent > Taken): apply, reject, revert ──
export interface AgentProposal {
  id: string; agent_id: string | null; agent_name: string | null; agent_color: string | null;
  kind: 'prompt' | 'model' | 'description' | 'skill' | 'other'; title: string; reason: string; evidence: string;
  before: string | null; after: string | null; status: 'open' | 'applied' | 'rejected' | 'reverted'; created_at: string; applied_at: string | null;
}
type ProposalList = { proposals: AgentProposal[] };
export const agentProposalsApi = {
  list: () => request<ProposalList>('/assistant/agent-proposals'),
  act: (id: string, action: 'apply' | 'reject' | 'revert') => request<ProposalList>(`/assistant/agent-proposals/${id}/${action}`, { method: 'POST' }),
};
