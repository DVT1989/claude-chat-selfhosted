// All API calls go to /api/* — nginx proxies to backend
const BASE = '/api';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
export const auth = {
  login: (email: string, password: string, totp_code?: string, remember = true) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, remember, ...(totp_code ? { totp_code } : {}) }) }),

  register: (email: string, password: string, name?: string) =>
    request('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, name }) }),

  logout: () =>
    request('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: import('@/types').User }>('/auth/me', { cache: 'no-store' }),

  updateProfile: (data: { name?: string; password?: string; currentPassword?: string; language?: string; avatar?: string | null; theme?: string; default_model?: string | null; theme_mode?: 'light' | 'dark' | 'system'; accent_color?: string; preferences?: { spellcheck?: boolean; spell_lang?: 'nl' | 'en' | 'auto'; bg_motion?: boolean; remote_notice?: boolean } }) =>
    request<{ ok: boolean; user?: import('@/types').User }>('/auth/me', { method: 'PUT', body: JSON.stringify(data) }),
};

// ── Conversations ─────────────────────────────────────────────
export const conversations = {
  list: (limit = 50, offset = 0) =>
    request<{ conversations: import('@/types').Conversation[] }>(`/conversations?limit=${limit}&offset=${offset}`),

  get: (id: string) =>
    request<import('@/types').ConversationDetail & { conversation: import('@/types').Conversation }>(`/conversations/${id}`),

  create: (data: { title?: string; model?: string; connectorIds?: string[]; deviceId?: string }) =>
    request<{ conversation: import('@/types').Conversation }>('/conversations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: string, data: Partial<{ title: string; model: string; status: string; connectorIds: string[] }>) =>
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
export interface ClaudeAccountInfo {
  slot: number; email: string | null; plan: string | null;
  usage: { session: UsageWindow | null; weekly: UsageWindow | null } | null;
  limited: boolean; active: boolean;
  /** when this account can take a message again; null when it has room now */
  usableAt: string | null;
}

export const claudeAuth = {
  /** newAccount: link an extra Claude subscription instead of (re)linking account 1 */
  start: (newAccount = false) =>
    request<{ url: string; slot: number }>('/claude-auth/start', { method: 'POST', body: JSON.stringify({ newAccount }) }),

  accounts: () =>
    request<{ accounts: ClaudeAccountInfo[] }>('/claude-auth/accounts'),

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
export const admin = {
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
  own?: { name: string; description: string; sizeKB: number; updatedAt: string; source?: string }[];
}
export type SkillImportResult = { imported: { name: string; source: string }[]; skipped: { path: string; reason: string }[] };
export type NewSkill = { name?: string; description?: string; instructions?: string; skillMd?: string };
export const skills = {
  list: () => request<SkillsManifest>('/skills'),
  add: (data: NewSkill) => request<{ ok: true; name: string }>('/skills', { method: 'POST', body: JSON.stringify(data) }),
  importGithub: (url: string) => request<SkillImportResult>('/skills/github', { method: 'POST', body: JSON.stringify({ url }) }),
  remove: (name: string) => request<{ ok: true }>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),
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
}
export type AgentInput = Omit<AgentDef, 'id' | 'slug' | 'created_at' | 'knowledge' | 'trained_at' | 'trained_conversations'>;
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
