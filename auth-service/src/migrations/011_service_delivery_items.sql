CREATE TABLE service_delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position >= 1),
  label TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  nonce BLOB NOT NULL,
  ciphertext BLOB NOT NULL,
  tag BLOB NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(service_id, position)
);

CREATE INDEX idx_service_delivery_items_service
ON service_delivery_items(service_id);
