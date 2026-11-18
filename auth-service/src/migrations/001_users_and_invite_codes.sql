CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','admin')),
  status TEXT NOT NULL CHECK(status IN ('active','disabled')),
  invited_by_code_id INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(email)
);

CREATE TABLE invite_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL,
  is_bootstrap INTEGER NOT NULL DEFAULT 0 CHECK(is_bootstrap IN (0,1)),
  created_by_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  max_uses INTEGER NOT NULL CHECK(max_uses>=1),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count>=0),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(code_hash),
  CHECK (
    (is_bootstrap=1 AND created_by_admin_id IS NULL)
    OR (is_bootstrap=0 AND created_by_admin_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_invite_codes_bootstrap_unique
  ON invite_codes(is_bootstrap) WHERE is_bootstrap=1;
