function require_env(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env variable: ${key}`);
  return val;
}

const appUrl = process.env.APP_URL ?? 'http://localhost:15980';

export const config = {
  port: parseInt(process.env.PORT ?? '4000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProd: process.env.NODE_ENV === 'production',

  databaseUrl: require_env('DATABASE_URL'),
  redisUrl: require_env('REDIS_URL'),
  jwtSecret: require_env('JWT_SECRET'),
  encryptionKey: require_env('ENCRYPTION_KEY'),
  corsOrigin: process.env.CORS_ORIGIN ?? '*',
  appUrl,

  sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  workspaceRoot: process.env.WORKSPACE_ROOT ?? '/workspace',
  claudeHomesRoot: process.env.CLAUDE_HOMES_ROOT ?? '/claude-homes',
  // Project dir on the host; mounted at the same path in the backend (selfupdate, backups, admin chat)
  projectDir: (process.env.PROJECT_DIR || '/volume1/docker/claude-chat').replace(/\/+$/, ''),
  // What the host is called in prompts and the server browser name (e.g. NAS); default: server
  hostLabel: (process.env.HOST_LABEL || 'server').trim(),
} as const;
