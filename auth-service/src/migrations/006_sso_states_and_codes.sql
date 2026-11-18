CREATE TABLE sso_states (
  flow_id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL,
  browser_nonce_hash TEXT NOT NULL,
  hmac_key_version INTEGER NOT NULL,
  web_session_id INTEGER REFERENCES sessions(id) ON DELETE RESTRICT,
  bound_user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  bound_session_family_id TEXT,
  codes_issued INTEGER NOT NULL DEFAULT 0 CHECK(codes_issued<=2),
  retry_count INTEGER NOT NULL DEFAULT 0 CHECK(retry_count IN (0,1)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE(state_hash),
  FOREIGN KEY (bound_session_family_id, bound_user_id)
    REFERENCES session_families(id, user_id) ON DELETE RESTRICT
);

CREATE TABLE sso_codes (
  code_hash TEXT PRIMARY KEY,
  hmac_key_version INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX idx_sso_codes_state ON sso_codes(state_hash);
