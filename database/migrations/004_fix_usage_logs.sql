-- Fix usage_logs: add cost_usd, make action optional so stream.ts INSERTs succeed
ALTER TABLE usage_logs
  ADD COLUMN IF NOT EXISTS cost_usd DECIMAL(10,6) NOT NULL DEFAULT 0;

ALTER TABLE usage_logs
  ALTER COLUMN action SET DEFAULT 'chat';
