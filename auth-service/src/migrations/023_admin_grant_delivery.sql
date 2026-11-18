ALTER TABLE admin_grants ADD COLUMN type_id TEXT;
ALTER TABLE admin_grants ADD COLUMN region_id TEXT;
ALTER TABLE admin_grants ADD COLUMN isp_id TEXT;
ALTER TABLE admin_grants ADD COLUMN spec_id TEXT;
ALTER TABLE admin_grants ADD COLUMN duration_id TEXT;
ALTER TABLE admin_grants ADD COLUMN months INTEGER;
ALTER TABLE admin_grants ADD COLUMN value_fen INTEGER;
ALTER TABLE admin_grants ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'pending_open'
  CHECK(delivery_status IN ('pending_open','open'));
ALTER TABLE admin_grants ADD COLUMN opened_at TEXT;

CREATE TABLE admin_grant_delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  grant_id INTEGER NOT NULL REFERENCES admin_grants(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position >= 1),
  label TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(grant_id, position)
);
