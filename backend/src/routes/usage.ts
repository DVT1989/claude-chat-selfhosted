import { Router, Request, Response } from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import { config } from '../config';
import { accountsOverview } from '../services/claudeAccounts';

export const usageRouter = Router();
usageRouter.use(requireAuth);

export type { UsageWindow, AnthropicUsage } from '../services/claudeAccounts';
export { parseOauthUsage } from '../services/claudeAccounts';

/** Read rate limit tier and email from stored credentials (best-effort). */
function readAccountInfo(userId: string): { rateLimitTier: string | null; emailAddress: string | null } {
  try {
    const credPath = join(config.claudeHomesRoot, `user-${userId}`, '.claude.json');
    const creds = JSON.parse(readFileSync(credPath, 'utf8')) as {
      oauthAccount?: { rateLimitTier?: string | null; emailAddress?: string | null };
    };
    return {
      rateLimitTier: creds.oauthAccount?.rateLimitTier ?? null,
      emailAddress:  creds.oauthAccount?.emailAddress ?? null,
    };
  } catch {
    return { rateLimitTier: null, emailAddress: null };
  }
}

usageRouter.get('/', async (req: Request, res: Response, next) => {
  try {
    // Primary: query usage_logs (populated per-message since April 2026)
    const logStats = await query<{
      week_tokens: string;
      today_tokens: string;
      week_messages: string;
      today_messages: string;
      week_cost_usd: string;
      today_cost_usd: string;
    }>(
      `SELECT
         COALESCE(SUM(input_tokens + output_tokens), 0)::text                                                                              AS week_tokens,
         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '1 day' THEN input_tokens + output_tokens END), 0)::text                    AS today_tokens,
         COUNT(*)::text                                                                                                                     AS week_messages,
         COUNT(CASE WHEN created_at >= NOW() - INTERVAL '1 day' THEN 1 END)::text                                                          AS today_messages,
         COALESCE(SUM(cost_usd), 0)::text                                                                                                  AS week_cost_usd,
         COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '1 day' THEN cost_usd END), 0)::text                                        AS today_cost_usd
       FROM usage_logs
       WHERE user_id = $1
         AND created_at >= NOW() - INTERVAL '7 days'`,
      [req.user!.userId],
    );

    // Fallback: conversations table (has data before usage_logs was populated)
    const convStats = await query<{
      week_tokens: string;
      today_tokens: string;
      week_messages: string;
      today_messages: string;
      week_cost_usd: string;
    }>(
      `SELECT
         COALESCE(SUM(token_count), 0)::text                                                              AS week_tokens,
         COALESCE(SUM(CASE WHEN updated_at >= NOW() - INTERVAL '1 day' THEN token_count END), 0)::text   AS today_tokens,
         COUNT(*)::text                                                                                    AS week_messages,
         COUNT(CASE WHEN updated_at >= NOW() - INTERVAL '1 day' THEN 1 END)::text                        AS today_messages,
         COALESCE(SUM(cost_usd), 0)::text                                                                 AS week_cost_usd
       FROM conversations
       WHERE user_id = $1
         AND updated_at >= NOW() - INTERVAL '7 days'
         AND status != 'deleted'`,
      [req.user!.userId],
    );

    const log = logStats.rows[0];
    const conv = convStats.rows[0];

    // Prefer usage_logs when it has data; fall back to conversations table
    const logTokens = parseInt(log.week_tokens, 10) || 0;
    const useLogData = logTokens > 0;

    const weekTokens   = useLogData ? logTokens                              : parseInt(conv.week_tokens, 10)   || 0;
    const todayTokens  = useLogData ? parseInt(log.today_tokens, 10)  || 0  : parseInt(conv.today_tokens, 10)  || 0;
    const weekMessages = useLogData ? parseInt(log.week_messages, 10) || 0  : parseInt(conv.week_messages, 10) || 0;
    const todayMessages= useLogData ? parseInt(log.today_messages, 10)|| 0  : parseInt(conv.today_messages, 10)|| 0;
    const weekCostUsd  = useLogData ? parseFloat(log.week_cost_usd)   || 0  : parseFloat(conv.week_cost_usd)   || 0;
    const todayCostUsd = useLogData ? parseFloat(log.today_cost_usd)  || 0  : 0;

    const account = readAccountInfo(req.user!.userId);
    // all linked Claude subscriptions; the bar under the composer shows the one the next message uses
    // last known reading at once, refreshed in the background; ?fresh=1 (after an answer) fetches now
    const accounts = await accountsOverview(req.user!.userId, req.query.fresh === '1' ? { fresh: true } : { swr: true });
    const anthropicUsage = accounts.find((a) => a.active)?.usage ?? null;

    res.json({
      weekTokens,
      todayTokens,
      weekMessages,
      todayMessages,
      weekCostUsd,
      todayCostUsd,
      rateLimitTier: account.rateLimitTier,
      anthropic: anthropicUsage,
      accounts,
    });
  } catch (err) {
    next(err);
  }
});
