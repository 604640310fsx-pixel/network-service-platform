CREATE TABLE referral_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE
    REFERENCES users(id) ON DELETE RESTRICT,
  public_code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  CHECK (
    length(public_code)=24
    AND public_code NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);
