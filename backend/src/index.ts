import { orphanResumable, parseDeployMarker, SELFUPDATE_RESUME_KEY, DEPLOY_MARKER_MS } from './services/resumePlan';
import { closeAllNas } from './services/nasBrowser';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { config } from './config';
import { guardProjectDir } from './services/projectDirGuard';
import { initRunUsers } from './services/runUsers';
import { pool } from './db';
import { redis } from './redis';
import { authRouter } from './routes/auth';
import { i18nRouter } from './routes/i18n';
import { ensureTranslationsTable } from './services/i18n';
import { conversationsRouter } from './routes/conversations';
import { projectsRouter } from './routes/projects';
import { streamRouter, resumeQueues, resumeAfterRestart } from './routes/stream';
import { ensureQueueSchema } from './services/messageQueue';
import { ensureSharedProjectSchema } from './services/sharedProjects';
import { startProjectMemoryWatcher } from './services/projectMemoryFile';
import { ensureDeviceSchema } from './services/devices';
import { ensureTransferSchema, startTransferSweeper } from './services/fileTransfers';
import { devicesRouter, resumeDeviceTasks } from './routes/devices';
import { ensureNasPasswordTables } from './services/nasPasswords';
import { remoteRouter } from './routes/remote';
import { lessonsRouter } from './routes/lessons';
import { federationRouter } from './routes/federation';
import { ensureFederationSchema, startFederationScheduler } from './services/federation';
import { ensureConsultSchema, startConsultScheduler } from './services/federationChat';
import { agentsRouter } from './routes/agents';
import { memoryRouter } from './routes/memory';
import { ensureMemorySchema } from './services/memory';
import { historyRouter } from './routes/history';
import { tasksRouter } from './routes/tasks';
import { ensureTasksSchema, startTaskScheduler } from './services/tasks';
import { assistantRouter } from './routes/assistant';
import { insightsRouter } from './routes/insights';
import { ninjaoneRouter } from './routes/ninjaone';
import { grippRouter } from './routes/gripp';
import { renderRouter } from './routes/render';
import { icloudRouter } from './routes/icloud';
import { ensureInsightsSchema } from './services/insights';
import { ensureHistorySchema } from './services/history';
import { ensureContextSchema } from './services/contextBudget';
import { ensureLearningSchema, startLearning, cleanupAll } from './services/learning';
import { resumeTrainings } from './services/agentTraining';
import { ensureAgentsSchema } from './services/agents';
import { ensureDelegationsSchema, startDelegations } from './services/delegations';
import { ensureLessonsSchema } from './services/lessons';
import { claudeAuthRouter } from './routes/claudeAuth';
import { connectorsRouter } from './routes/connectors';
import { adminRouter } from './routes/admin';
import { usageRouter } from './routes/usage';
import { errorHandler } from './middleware/errorHandler';
import { startScheduler } from './services/scheduler';
import { claudeAiRouter } from './routes/claudeAi';
import { attachmentsRouter } from './routes/attachments';
import { modelsRouter, startModelRefresh } from './routes/models';
import { skillsRouter } from './routes/skills';
import { groupsRouter } from './routes/groups';
import { totpRouter } from './routes/totp';
import { pushRouter } from './routes/push';
import { telegramRouter } from './routes/telegram';
import { telegramBotsRouter } from './routes/telegramBots';
import { m365Router } from './routes/m365';
import { googleRouter } from './routes/google';
import { ensureSettingsTable } from './services/googleSearchConsole';
import { startTelegram, ensureTelegramSchema } from './services/telegram/manager';
import { startAgentBots, ensureAgentBotSchema } from './services/telegram/agentBots';
import { whatsappRouter } from './routes/whatsapp';
import { messengerRouter } from './routes/messenger';
import cron from 'node-cron';
import { createBackup } from './services/backup';
import { BOOT_ID, announceRestart } from './services/sseEvents';
import { ensureMessengerSchema } from './services/messenger';
import { startWhatsApp, ensureWhatsAppSchema } from './services/whatsapp/manager';

const app = express();

// ── Security ─────────────────────────────────────────────────
app.set('trust proxy', 1); // Trust nginx proxy

app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // Next.js needs unsafe-inline for the inline FOAUC theme bootstrap script in app/layout.tsx
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      // self covers SSE/EventSource and fetch /api on the same origin
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
    },
  },
}));

const allowedOrigins = config.corsOrigin === '*'
  ? true
  : config.corsOrigin.split(',').map(o => o.trim());

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins === true) return callback(null, true);
    if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) return callback(null, true);
    callback(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
}));

app.use(express.json({ limit: '25mb' }));
// Express 5 leaves req.body undefined when no body was sent; keep the old {} behaviour.
app.use((req, _res, next) => { if (req.body === undefined) req.body = {}; next(); });
app.use(cookieParser());

// ── Health ────────────────────────────────────────────────────
// Above the rate limiter: clients poll it while waiting for a restart. bootId changes per process start.
app.get('/health', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ status: 'ok', timestamp: new Date().toISOString(), bootId: BOOT_ID });
});

// ── Restart notice (selfupdate) ───────────────────────────────
// Called via docker exec from the selfupdate helper (loopback, INTERNAL_API_KEY) after a successful build,
// right before the containers are recreated. Pushes a countdown to every open client.
app.post('/internal/restart-notice', (req, res) => {
  const key = process.env.INTERNAL_API_KEY;
  if (!key || req.get('x-internal-key') !== key) { res.status(403).json({ error: 'forbidden' }); return; }
  const seconds = Math.min(120, Math.max(0, Number(req.body?.seconds) || 10));
  const raw = req.body?.services;
  const services = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : ['backend'])
    .filter((x: unknown): x is string => typeof x === 'string' && ['backend', 'frontend', 'nginx'].includes(x));
  const list = services.length ? services : ['backend'];
  // the conversation that ran selfupdate continues by itself after the restart (resumeAfterRestart)
  const conv = typeof req.body?.conversationId === 'string' ? req.body.conversationId : '';
  if (list.includes('backend') && /^[0-9a-f-]{36}$/.test(conv)) {
    redis.set(SELFUPDATE_RESUME_KEY, JSON.stringify({ conversationId: conv, at: Date.now() }), 'EX', Math.ceil(DEPLOY_MARKER_MS / 1000))
      .catch((e: Error) => console.error('[selfupdate] marker failed:', e.message));
  }
  res.json(announceRestart(seconds, list));
});

// Agents still at work (selfupdate asks before restarting the backend). Loopback + INTERNAL_API_KEY.
app.get('/internal/active-agents', async (req, res) => {
  const key = process.env.INTERNAL_API_KEY;
  if (!key || req.get('x-internal-key') !== key) { res.status(403).json({ error: 'forbidden' }); return; }
  const { activeAgentCalls } = await import('./services/claudeCode');
  // the caller's own run (an agent in its workplace that rolls out itself) does not block: it resumes after the restart
  const exclude = String(req.query.exclude ?? '');
  res.json({ agents: [...activeAgentCalls.values()].filter((a) => !exclude || a.conversationId !== exclude).map((a) => ({ ...a, minutes: Math.round((Date.now() - a.since) / 60000) })) });
});

// Backfill of the learning loop for one user (started from the admin chat via docker exec)
app.post('/internal/learn-backfill', async (req, res) => {
  const key = process.env.INTERNAL_API_KEY;
  if (!key || req.get('x-internal-key') !== key) { res.status(403).json({ error: 'forbidden' }); return; }
  const userId = String(req.body?.userId ?? '');
  if (!/^[0-9a-f-]{36}$/.test(userId)) { res.status(400).json({ error: 'userId' }); return; }
  const learning = await import('./services/learning');
  await learning.startBackfill(userId);
  res.json(await learning.backfillStatus(userId));
});

// Remote desktop: many small requests per second (frames, input), own auth per route
app.use('/devices/remote', remoteRouter);

// Federation: own rate limit, own auth (API key or admin)
app.use('/federation', federationRouter);

// ── General rate limiting ─────────────────────────────────────
app.use(rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
}));

// ── Routes ────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/i18n', i18nRouter);
app.use('/projects', projectsRouter);
app.use('/conversations', conversationsRouter);
app.use('/conversations', streamRouter);
app.use('/claude-auth', claudeAuthRouter);
app.use('/connectors/google', googleRouter);
app.use('/connectors', connectorsRouter);
app.use('/admin', adminRouter);
app.use('/usage', usageRouter);
app.use('/claude-ai', claudeAiRouter);
app.use('/conversations', attachmentsRouter);
app.use('/models', modelsRouter);
app.use('/skills', skillsRouter);
app.use('/groups', groupsRouter);
app.use('/auth/totp', totpRouter);
app.use('/push', pushRouter);
app.use('/telegram', telegramRouter);
app.use('/telegram-bots', telegramBotsRouter);
app.use('/whatsapp', whatsappRouter);
app.use('/messenger', messengerRouter);
app.use('/m365', m365Router);
app.use('/devices', devicesRouter);
app.use('/lessons', lessonsRouter);
app.use('/agents', agentsRouter);
app.use('/memory', memoryRouter);
app.use('/history', historyRouter);
app.use('/tasks', tasksRouter);
app.use('/assistant', assistantRouter);
app.use('/insights', insightsRouter);
app.use('/ninjaone', ninjaoneRouter);
app.use('/gripp', grippRouter);
app.use('/render', renderRouter);
app.use('/icloud', icloudRouter);

// ── Error handler ─────────────────────────────────────────────
app.use(errorHandler);

// ── Start ─────────────────────────────────────────────────────
let interruptedConvs: string[] = [];
async function start() {
  // Verify DB connection
  try {
    await pool.query('SELECT 1');
    console.log('✓ PostgreSQL connected');
  } catch (err) {
    console.error('✗ PostgreSQL connection failed:', err);
    process.exit(1);
  }

  // Run pending migrations
  try {
    await ensureTranslationsTable();
    await ensureNasPasswordTables();
    await ensureSettingsTable();
    // Microsoft 365 became opt-in per agent: keep explicit read/write entries, drop 'none' (and so every agent without an entry)
    await pool.query(`UPDATE connectors SET config = config || jsonb_build_object('agent_access_v', 2, 'agent_access',
        COALESCE((SELECT jsonb_object_agg(k, v) FROM jsonb_each_text(COALESCE(config->'agent_access', '{}'::jsonb)) AS e(k, v) WHERE v IN ('read', 'write')), '{}'::jsonb))
      WHERE type = 'm365' AND COALESCE((config->>'agent_access_v')::int, 0) < 2`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS conversation_attachments (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        color VARCHAR(16) NOT NULL DEFAULT 'terracotta',
        icon VARCHAR(32) NOT NULL DEFAULT 'folder',
        instructions TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id)');
    await pool.query('ALTER TABLE conversations ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_conv_att_conv ON conversation_attachments(conversation_id)');
    // Sent attachments leave the composer (they stay visible in the message they went with)
    await pool.query('ALTER TABLE conversation_attachments ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS default_model VARCHAR(64)');
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret VARCHAR(64)');
    await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS pending_totp_secret VARCHAR(64)');
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS theme_mode VARCHAR(16) NOT NULL DEFAULT 'system'");
    await pool.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS accent_color VARCHAR(7) NOT NULL DEFAULT '#CC785C'");
    // Backfill: derive from old theme column
    // theme_mode backfill from the old theme column removed: it ran on every start and reset a chosen 'system' to dark
    await pool.query(`UPDATE users SET accent_color = CASE
      WHEN theme = 'dark-blue' THEN '#4A9EFF'
      WHEN theme = 'light-blue' THEN '#2563EB'
      ELSE accent_color END
      WHERE accent_color = '#CC785C' AND theme IS NOT NULL`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        user_agent TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS system_config (
        key VARCHAR(64) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await ensureTelegramSchema();
    await ensureWhatsAppSchema();
    await ensureMessengerSchema();
    await ensureQueueSchema();
    await ensureSharedProjectSchema();
    await ensureDeviceSchema();
    await ensureTransferSchema();
    startTransferSweeper();
    await ensureLessonsSchema();
    await ensureAgentsSchema();
    await ensureAgentBotSchema(); // after agents: it references them
    await ensureMemorySchema();
    await ensureHistorySchema();
    await ensureContextSchema();
    await ensureLearningSchema();
    await ensureTasksSchema();
    await ensureDelegationsSchema();
    await ensureInsightsSchema();
    await ensureFederationSchema();
    await ensureConsultSchema();
    console.log('✓ Migrations applied');
    // Claude runs as a child of this process, so any stream still flagged at boot died with the previous process.
    const orphaned = await pool.query<{ conversation_id: string; id: string; created_at: Date }>(
      `UPDATE messages SET metadata = (metadata - 'streaming') || '{"interrupted": true}'::jsonb WHERE metadata->>'streaming' = 'true' RETURNING conversation_id, id, created_at`);
    // any run killed mid-answer (also during a tool call) is resumed; the window counts from the answer's
    // start, so long runs (more than 30 minutes) are no longer skipped
    interruptedConvs = orphaned.rows.filter((r) => orphanResumable(r.created_at)).map((r) => r.conversation_id);
    if (orphaned.rowCount) console.log(`✓ ${orphaned.rowCount} afgebroken stream(s) afgesloten`);
  } catch (err) {
    console.error('✗ Migration failed:', err);
  }

  // Bootstrap admin user
  try {
    const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', ['admin']);
    if (rows.length === 0) {
      const adminPassword = process.env.ADMIN_PASSWORD || randomBytes(16).toString('hex');
      const hash = await bcrypt.hash(adminPassword, 12);
      await pool.query(
        `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)`,
        ['admin', hash, 'Admin', 'admin'],
      );
      if (!process.env.ADMIN_PASSWORD) {
        console.log(`✓ Admin user created — WACHTWOORD: ${adminPassword}  (stel ADMIN_PASSWORD in om dit te voorkomen)`);
      } else {
        console.log('✓ Admin user created');
      }
    }
  } catch (err) {
    console.error('✗ Admin bootstrap failed:', err);
  }


  try { await initRunUsers(); } catch (err) { console.error('✗ Run users init failed:', err); }
  try { guardProjectDir(); } catch (err) { console.error('✗ Project dir guard failed:', err); }

  // Verify Redis connection
  try {
    await redis.ping();
    console.log('✓ Redis connected');
  } catch (err) {
    console.error('✗ Redis connection failed:', err);
    process.exit(1);
  }

  app.listen(config.port, '0.0.0.0', () => {
    console.log(`✓ Backend running on port ${config.port} [${config.nodeEnv}]`);
  });

  startScheduler();
  startProjectMemoryWatcher();
  startTaskScheduler();
  startFederationScheduler();
  startConsultScheduler();
  startDelegations();
  void resumeQueues();
  // the conversation that started a selfupdate continues by itself and checks the rollout (no "typ verder")
  const deployConv = parseDeployMarker(await redis.getdel(SELFUPDATE_RESUME_KEY).catch(() => null));
  void resumeAfterRestart(interruptedConvs, deployConv); // also lets cut-off agents finish (AGENT_AUTO_RESUME=0: off)
  void resumeDeviceTasks();
  startModelRefresh();
  void startTelegram();
  void startAgentBots();
  void startWhatsApp();
  startLearning();
  setTimeout(() => void resumeTrainings().catch((e) => console.error('[training] hervatten:', e)), 150_000).unref();

  // Memory cleanup (archive long unused facts, merge near-duplicates) once a day, after the backup
  cron.schedule('15 4 * * *', () => {
    cleanupAll().catch((err: Error) => console.error('[learning] cleanup error:', err));
  });

  // Daily backup at 03:00 (moved here from the former admin-claude container)
  cron.schedule('0 3 * * *', () => {
    console.log('[backup] Starting scheduled backup');
    createBackup().catch((err: Error) => console.error('[backup] Scheduled backup error:', err));
  });
}

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await closeAllNas().catch(() => undefined);
  await pool.end();
  await redis.quit();
  process.exit(0);
});

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
