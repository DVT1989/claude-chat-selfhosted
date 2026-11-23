-- Wachtwoordmanager van Browser (NAS): per gebruiker opgeslagen inloggegevens (wachtwoord versleuteld, AES-256-GCM)
CREATE TABLE IF NOT EXISTS nas_passwords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  host TEXT NOT NULL,
  username TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, origin, username)
);
CREATE INDEX IF NOT EXISTS idx_nas_passwords_user_origin ON nas_passwords(user_id, origin);
-- "Nooit opslaan voor deze site"
CREATE TABLE IF NOT EXISTS nas_password_never (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, origin)
);
