CREATE TABLE session_families (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(id, user_id)
);

CREATE INDEX idx_session_families_user ON session_families(user_id);

CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL,
  hmac_key_version INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  session_family_id TEXT NOT NULL,
  audience TEXT NOT NULL CHECK(audience IN ('web','monitor')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE(token_hash),
  FOREIGN KEY (session_family_id, user_id)
    REFERENCES session_families(id, user_id) ON DELETE RESTRICT
);

CREATE INDEX idx_sessions_family ON sessions(session_family_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
