-- Generated UI languages (outside git: content lives only in the database)
CREATE TABLE IF NOT EXISTS translations (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  messages JSONB NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
