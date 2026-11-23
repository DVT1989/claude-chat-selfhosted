-- Federation between claude-chat installations (mirror of ensureFederationSchema in services/federation.ts)

CREATE TABLE IF NOT EXISTS federation_self (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL DEFAULT 'Deze installatie');

CREATE TABLE IF NOT EXISTS federation_keys (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('read','readwrite')),
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ);

CREATE TABLE IF NOT EXISTS federation_peers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      api_key_enc TEXT NOT NULL,
      remote_install_id TEXT,
      remote_name TEXT,
      direction TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      nightly BOOLEAN NOT NULL DEFAULT TRUE,
      kinds JSONB NOT NULL DEFAULT '{}',
      cursors JSONB NOT NULL DEFAULT '{}',
      push_cursors JSONB NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'new',
      status_message TEXT,
      last_sync_at TIMESTAMPTZ,
      last_nightly_on DATE,
      last_result JSONB,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS federation_origin (
      install_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      local_id TEXT NOT NULL,
      remote_hash TEXT NOT NULL,
      local_hash TEXT NOT NULL,
      pushed BOOLEAN NOT NULL DEFAULT FALSE,
      synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (install_id, kind, remote_id));

CREATE TABLE IF NOT EXISTS federation_conflicts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      install_id TEXT NOT NULL,
      install_name TEXT,
      peer_id UUID REFERENCES federation_peers(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      local_id TEXT,
      owner_id UUID,
      name TEXT NOT NULL DEFAULT '',
      remote_item JSONB NOT NULL,
      local_preview JSONB,
      status TEXT NOT NULL DEFAULT 'open',
      resolution TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ);

CREATE UNIQUE INDEX IF NOT EXISTS federation_conflicts_open_idx ON federation_conflicts (install_id, kind, remote_id) WHERE status = 'open';

CREATE INDEX IF NOT EXISTS federation_origin_local_idx ON federation_origin (kind, local_id);

INSERT INTO federation_self (name) SELECT 'Deze installatie' WHERE NOT EXISTS (SELECT 1 FROM federation_self);
