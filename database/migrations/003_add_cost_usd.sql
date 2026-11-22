-- Add cost_usd tracking to conversations
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_conversations_cost_usd
  ON conversations (user_id, updated_at DESC);
