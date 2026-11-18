-- Migration 021: personal invites.
--
-- Runs only through the runner's dedicated path: foreign_keys is switched OFF on
-- the exclusive startup connection outside any transaction, this whole file plus
-- the full foreign_key_check and the schema_migrations record commit in ONE
-- exclusive transaction, and foreign_keys is restored and verified before the
-- service can become ready. Tables are rebuilt by drop-and-recreate under the
-- same name (no ALTER TABLE ... RENAME), so every existing reference keeps
-- resolving to the same name and every row keeps its primary key and values.
--
-- users: an account now records exactly one origin, either the legacy
-- admin-issued invite code (unchanged for every existing row) or a real direct
-- inviter account. Both are immutable after insert; self-invites are rejected.
-- pending_registrations: a pending registration binds exactly one of the legacy
-- invite code or the inviter's referral profile (personal code).

CREATE TEMP TABLE migration021_sequences AS
  SELECT name, seq FROM sqlite_sequence
  WHERE name IN ('users', 'pending_registrations');

-- ---------- users ----------
CREATE TEMP TABLE migration021_users AS SELECT * FROM users;

DROP TABLE users;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','admin')),
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  invited_by_code_id INTEGER REFERENCES invite_codes(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  invited_by_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  UNIQUE(email),
  CHECK ((invited_by_code_id IS NULL) <> (invited_by_user_id IS NULL)),
  CHECK (invited_by_user_id IS NULL OR invited_by_user_id <> id)
);

INSERT INTO users (
  id, email, password_hash, role, status, invited_by_code_id,
  created_at, updated_at, invited_by_user_id
)
SELECT
  id, email, password_hash, role, status, invited_by_code_id,
  created_at, updated_at, NULL
FROM temp.migration021_users
ORDER BY id;

CREATE INDEX idx_users_invited_by_user
  ON users (invited_by_user_id)
  WHERE invited_by_user_id IS NOT NULL;

CREATE TRIGGER trg_users_inviter_active_insert
BEFORE INSERT ON users
FOR EACH ROW
WHEN NEW.invited_by_user_id IS NOT NULL
 AND NOT EXISTS (
   SELECT 1 FROM users AS inviter
   WHERE inviter.id = NEW.invited_by_user_id
     AND inviter.status = 'active'
     AND inviter.email <> NEW.email
 )
BEGIN
  SELECT RAISE(ABORT, 'user_inviter_invalid');
END;

CREATE TRIGGER trg_users_invite_origin_immutable
BEFORE UPDATE OF invited_by_code_id, invited_by_user_id ON users
FOR EACH ROW
WHEN NEW.invited_by_code_id IS NOT OLD.invited_by_code_id
  OR NEW.invited_by_user_id IS NOT OLD.invited_by_user_id
BEGIN
  SELECT RAISE(ABORT, 'user_invite_origin_is_immutable');
END;

DROP TABLE temp.migration021_users;

-- ---------- pending_registrations ----------
CREATE TEMP TABLE migration021_pending AS SELECT * FROM pending_registrations;

DROP TABLE pending_registrations;

CREATE TABLE pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  registration_token_hash TEXT NOT NULL,
  registration_token_key_version INTEGER NOT NULL,
  invite_code_id INTEGER REFERENCES invite_codes(id) ON DELETE RESTRICT,
  otp_hash TEXT NOT NULL,
  otp_key_version INTEGER NOT NULL,
  otp_generation INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL CHECK(phase IN ('awaiting_verification','verified','completed')),
  verified_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  resend_count INTEGER NOT NULL DEFAULT 1 CHECK(resend_count>=1),
  last_sent_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL,
  referral_source_profile_id INTEGER
    REFERENCES referral_profiles(id) ON DELETE RESTRICT,
  personal_inviter_profile_id INTEGER
    REFERENCES referral_profiles(id) ON DELETE RESTRICT,
  UNIQUE(registration_token_hash),
  CHECK ((invite_code_id IS NULL) <> (personal_inviter_profile_id IS NULL))
);

INSERT INTO pending_registrations (
  id, email, registration_token_hash, registration_token_key_version,
  invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
  verified_at, attempts, resend_count, last_sent_at, expires_at,
  consumed_at, superseded_at, created_at, referral_source_profile_id,
  personal_inviter_profile_id
)
SELECT
  id, email, registration_token_hash, registration_token_key_version,
  invite_code_id, otp_hash, otp_key_version, otp_generation, phase,
  verified_at, attempts, resend_count, last_sent_at, expires_at,
  consumed_at, superseded_at, created_at, referral_source_profile_id,
  NULL
FROM temp.migration021_pending
ORDER BY id;

CREATE INDEX idx_pending_email ON pending_registrations(email);
CREATE INDEX idx_pending_expiry ON pending_registrations(expires_at);

-- The 016 legacy invite binding, unchanged for rows that bind an invite code.
CREATE TRIGGER trg_pending_registrations_prebound_insert
BEFORE INSERT ON pending_registrations
FOR EACH ROW
WHEN NEW.invite_code_id IS NOT NULL
 AND NOT EXISTS (
  SELECT 1 FROM invite_codes AS i
  WHERE i.id=NEW.invite_code_id
    AND i.is_bootstrap=0
    AND i.recipient_email IS NOT NULL
    AND i.recipient_email=NEW.email
)
BEGIN
  SELECT RAISE(ABORT,'pending_registration_invite_binding_mismatch');
END;

CREATE TRIGGER trg_pending_registrations_personal_insert
BEFORE INSERT ON pending_registrations
FOR EACH ROW
WHEN NEW.personal_inviter_profile_id IS NOT NULL
 AND NOT EXISTS (
  SELECT 1
  FROM referral_profiles AS p
  JOIN users AS inviter ON inviter.id = p.user_id
  WHERE p.id = NEW.personal_inviter_profile_id
    AND inviter.status = 'active'
    AND inviter.email <> NEW.email
)
BEGIN
  SELECT RAISE(ABORT,'pending_registration_personal_inviter_invalid');
END;

CREATE TRIGGER trg_pending_registrations_binding_immutable
BEFORE UPDATE OF email,invite_code_id,personal_inviter_profile_id ON pending_registrations
FOR EACH ROW
WHEN NEW.email IS NOT OLD.email
  OR NEW.invite_code_id IS NOT OLD.invite_code_id
  OR NEW.personal_inviter_profile_id IS NOT OLD.personal_inviter_profile_id
BEGIN
  SELECT RAISE(ABORT,'pending_registration_binding_is_immutable');
END;

DROP TABLE temp.migration021_pending;

-- ---------- AUTOINCREMENT high-water marks ----------
-- DROP TABLE removed the old sqlite_sequence rows and the copies above wrote
-- max(id); restore the exact previous values so no id is ever reused.
DELETE FROM sqlite_sequence
WHERE name IN (SELECT name FROM temp.migration021_sequences);
INSERT INTO sqlite_sequence (name, seq)
SELECT name, seq FROM temp.migration021_sequences;

DROP TABLE temp.migration021_sequences;
