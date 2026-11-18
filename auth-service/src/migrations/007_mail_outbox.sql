CREATE TABLE mail_outbox (
  idempotency_key TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  template TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','sending')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_attempt_at TEXT NOT NULL,
  leased_until TEXT,
  lease_token TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_outbox_pending ON mail_outbox(status, next_attempt_at);
CREATE INDEX idx_outbox_leased ON mail_outbox(status, leased_until);

CREATE TABLE mail_outbox_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL,
  to_email_hmac TEXT NOT NULL,
  template TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('sent','failed')),
  final_attempts INTEGER NOT NULL,
  recorded_at TEXT NOT NULL
);
