-- 006_totp_column_text.sql
-- Migration: extend totp secret columns to TEXT
--
-- The crypto.ts encrypt() helper produces base64-encoded ciphertext
-- (iv:tag:ciphertext) that exceeds 64 chars. Existing VARCHAR(64) silently
-- truncates secrets, locking users out of 2FA. This migration extends both
-- columns to TEXT and resets totp_enabled for any users with stored values,
-- forcing them to re-enroll (existing secrets are likely corrupted and
-- unrecoverable).
--
-- Idempotent: only ALTERs columns still typed as character varying, and
-- only resets totp state on first apply (when columns were just changed).
-- Safe to re-run via /docker-entrypoint-initdb.d on a fresh volume.

DO $mig$
DECLARE
  changed BOOLEAN := FALSE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'totp_secret'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE users ALTER COLUMN totp_secret TYPE TEXT;
    changed := TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'users'
      AND column_name = 'pending_totp_secret'
      AND data_type = 'character varying'
  ) THEN
    ALTER TABLE users ALTER COLUMN pending_totp_secret TYPE TEXT;
    changed := TRUE;
  END IF;

  -- Only reset secrets if we just migrated from VARCHAR(64) (potentially
  -- corrupted). Subsequent runs are no-ops and leave new TOTP setups alone.
  IF changed THEN
    UPDATE users
    SET totp_enabled = false,
        totp_secret = NULL,
        pending_totp_secret = NULL
    WHERE totp_enabled = true
       OR totp_secret IS NOT NULL
       OR pending_totp_secret IS NOT NULL;
  END IF;
END
$mig$;
