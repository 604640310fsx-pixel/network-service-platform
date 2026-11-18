CREATE TABLE pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  registration_token_hash TEXT NOT NULL,
  registration_token_key_version INTEGER NOT NULL,
  invite_code_id INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE RESTRICT,
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
  UNIQUE(registration_token_hash)
);

CREATE INDEX idx_pending_email ON pending_registrations(email);
CREATE INDEX idx_pending_expiry ON pending_registrations(expires_at);
