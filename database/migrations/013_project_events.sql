-- Gedeelde projecten zonder eigenaar: geschiedenis van wijzigingen, wie een agent toevoegde, sync-status geheugen.md.
-- Wordt ook bij het starten van de backend toegepast (services/sharedProjects.ts ensureSharedProjectSchema).
CREATE TABLE IF NOT EXISTS project_events (
  id BIGSERIAL PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_events_project_idx ON project_events (project_id, id DESC);
ALTER TABLE project_agents ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE project_connectors ADD COLUMN IF NOT EXISTS added_by UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS project_memory_sync (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  file_hash TEXT NOT NULL,
  db_hash TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
