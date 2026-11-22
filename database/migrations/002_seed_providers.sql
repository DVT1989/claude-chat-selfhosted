-- Seed default providers
INSERT INTO providers (id, name, type, config) VALUES
  (
    '00000000-0000-0000-0000-000000000001',
    'Claude (Anthropic)',
    'claude',
    '{"models": ["claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5-20251001"], "default_model": "claude-opus-4-5", "base_url": "https://api.anthropic.com"}'
  )
ON CONFLICT (id) DO NOTHING;
