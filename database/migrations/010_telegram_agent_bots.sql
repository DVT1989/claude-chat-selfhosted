-- 010: Telegram-agentbots. Per user meerdere bots met eigen token; elke bot heeft gekoppelde agents
-- en een lijst chatters die de eigenaar moet goedkeuren. telegram_links (persoonlijke bot) blijft ongewijzigd.
-- Het backend-opstartscript maakt dezelfde tabellen aan (ensureAgentBotSchema); dit bestand is voor een lege installatie.
CREATE TABLE IF NOT EXISTS telegram_agent_bots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bot_token_enc TEXT NOT NULL,
  bot_username TEXT,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  rate_per_hour INTEGER NOT NULL DEFAULT 20,
  update_offset BIGINT NOT NULL DEFAULT 0,
  status TEXT,
  status_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_agent_bots_user_idx ON telegram_agent_bots (user_id);
CREATE TABLE IF NOT EXISTS telegram_agent_bot_agents (
  bot_id UUID NOT NULL REFERENCES telegram_agent_bots(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (bot_id, agent_id)
);
CREATE TABLE IF NOT EXISTS telegram_agent_chatters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id UUID NOT NULL REFERENCES telegram_agent_bots(id) ON DELETE CASCADE,
  chat_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  username TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | revoked
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (bot_id, chat_id)
);
CREATE TABLE IF NOT EXISTS telegram_agent_hits (
  chatter_id UUID NOT NULL REFERENCES telegram_agent_chatters(id) ON DELETE CASCADE,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS telegram_agent_hits_idx ON telegram_agent_hits (chatter_id, at);
