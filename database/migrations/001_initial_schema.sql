-- ============================================================
-- Initial Schema — claude-chat
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ────────────────────────────────────────────────────
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name          VARCHAR(255),
    role          VARCHAR(50)  NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
    is_active     BOOLEAN      NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users (email);

-- ── Sessions ─────────────────────────────────────────────────
CREATE TABLE sessions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  VARCHAR(255) UNIQUE NOT NULL,   -- SHA-256 of JWT
    ip_address  VARCHAR(50),
    user_agent  TEXT,
    expires_at  TIMESTAMPTZ  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sessions_user_id   ON sessions (user_id);
CREATE INDEX idx_sessions_token_hash ON sessions (token_hash);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);

-- ── Providers ────────────────────────────────────────────────
CREATE TABLE providers (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       VARCHAR(100) NOT NULL,         -- 'Claude', 'OpenAI', …
    type       VARCHAR(50)  NOT NULL,         -- 'claude', 'openai', …
    config     JSONB        NOT NULL DEFAULT '{}',
    is_active  BOOLEAN      NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── Provider Accounts (per user) ─────────────────────────────
CREATE TABLE provider_accounts (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_id          UUID         NOT NULL REFERENCES providers (id),
    name                 VARCHAR(255) NOT NULL,
    credentials_enc      TEXT         NOT NULL,   -- AES-256-GCM encrypted JSON
    status               VARCHAR(50)  NOT NULL DEFAULT 'active',  -- 'active' | 'limit_reached' | 'error'
    limit_reached        BOOLEAN      NOT NULL DEFAULT false,
    limit_reset_at       TIMESTAMPTZ,
    last_used_at         TIMESTAMPTZ,
    metadata             JSONB        NOT NULL DEFAULT '{}',
    created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_provider_accounts_user_id ON provider_accounts (user_id);

-- ── Conversations ─────────────────────────────────────────────
CREATE TABLE conversations (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_account_id UUID         REFERENCES provider_accounts (id) ON DELETE SET NULL,
    title               VARCHAR(500) NOT NULL DEFAULT 'New conversation',
    model               VARCHAR(100) NOT NULL DEFAULT 'claude-opus-4-5',
    status              VARCHAR(50)  NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
    token_count         INTEGER      NOT NULL DEFAULT 0,
    metadata            JSONB        NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_conversations_user_id    ON conversations (user_id);
CREATE INDEX idx_conversations_updated_at ON conversations (updated_at DESC);

-- ── Messages ─────────────────────────────────────────────────
CREATE TABLE messages (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id UUID        NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    role            VARCHAR(50) NOT NULL,   -- 'user' | 'assistant' | 'system'
    content         TEXT        NOT NULL,
    token_count     INTEGER     NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_messages_conversation_id ON messages (conversation_id);
CREATE INDEX idx_messages_created_at      ON messages (created_at);

-- ── Conversation States (for resume) ─────────────────────────
CREATE TABLE conversation_states (
    conversation_id UUID PRIMARY KEY REFERENCES conversations (id) ON DELETE CASCADE,
    state           JSONB       NOT NULL DEFAULT '{}',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Connectors ───────────────────────────────────────────────
CREATE TABLE connectors (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name             VARCHAR(255) NOT NULL,
    type             VARCHAR(50)  NOT NULL,   -- 'git' | 'ssh' | 'ftp' | 'smb' | 'python' | 'onedrive'
    credentials_enc  TEXT,                    -- AES-256-GCM encrypted JSON
    config           JSONB        NOT NULL DEFAULT '{}',
    is_active        BOOLEAN      NOT NULL DEFAULT true,
    last_tested_at   TIMESTAMPTZ,
    test_status      VARCHAR(50),             -- 'ok' | 'error'
    test_message     TEXT,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connectors_user_id ON connectors (user_id);

-- ── Conversation ↔ Connectors ─────────────────────────────────
CREATE TABLE conversation_connectors (
    conversation_id UUID NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    connector_id    UUID NOT NULL REFERENCES connectors (id) ON DELETE CASCADE,
    PRIMARY KEY (conversation_id, connector_id)
);

-- ── Usage Logs ────────────────────────────────────────────────
CREATE TABLE usage_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider_account_id UUID         REFERENCES provider_accounts (id) ON DELETE SET NULL,
    conversation_id     UUID         REFERENCES conversations (id) ON DELETE SET NULL,
    action              VARCHAR(100) NOT NULL,
    input_tokens        INTEGER      NOT NULL DEFAULT 0,
    output_tokens       INTEGER      NOT NULL DEFAULT 0,
    metadata            JSONB        NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_usage_logs_user_id         ON usage_logs (user_id);
CREATE INDEX idx_usage_logs_created_at      ON usage_logs (created_at DESC);
CREATE INDEX idx_usage_logs_provider_acc_id ON usage_logs (provider_account_id);

-- ── Audit Logs ───────────────────────────────────────────────
CREATE TABLE audit_logs (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID         REFERENCES users (id) ON DELETE SET NULL,
    action        VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id   UUID,
    ip_address    VARCHAR(50),
    metadata      JSONB        NOT NULL DEFAULT '{}',
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_logs_user_id    ON audit_logs (user_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at DESC);

-- ── updated_at trigger ────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_conversations_updated_at
    BEFORE UPDATE ON conversations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_provider_accounts_updated_at
    BEFORE UPDATE ON provider_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_connectors_updated_at
    BEFORE UPDATE ON connectors
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
