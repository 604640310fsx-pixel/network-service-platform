CREATE TABLE invite_code_redemptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invite_code_id INTEGER NOT NULL REFERENCES invite_codes(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  redeemed_at TEXT NOT NULL,
  ip_address TEXT NOT NULL
);

CREATE INDEX idx_redemptions_code ON invite_code_redemptions(invite_code_id);
CREATE INDEX idx_redemptions_user ON invite_code_redemptions(user_id);
