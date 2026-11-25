-- Gedeelde projecten (groepschat): kleur per deelnemer, agents per project, projectgeheugen.
-- Wordt ook bij het starten van de backend toegepast (services/sharedProjects.ts ensureSharedProjectSchema).
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);
-- de eigenaar is het eerste lid; projects.user_id blijft het technische anker
INSERT INTO project_members (project_id, user_id) SELECT id, user_id FROM projects ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS project_connectors (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, connector_id)
);
CREATE TABLE IF NOT EXISTS conversation_reads (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE SEQUENCE IF NOT EXISTS project_gid_seq START 30000 MINVALUE 30000;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS gid INTEGER;
ALTER TABLE project_members ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_color TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS project_members_color_idx ON project_members (project_id, color) WHERE color IS NOT NULL;
CREATE TABLE IF NOT EXISTS project_agents (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  account_mode TEXT NOT NULL DEFAULT 'user' CHECK (account_mode IN ('user','owner')),
  fallback BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (project_id, agent_id)
);
CREATE TABLE IF NOT EXISTS project_agent_users (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, agent_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT 'algemeen',
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  added_via TEXT NOT NULL DEFAULT 'person',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_memory_project_idx ON project_memory (project_id);
