CREATE TABLE rate_limit_buckets (
  bucket_key TEXT NOT NULL,
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bucket_key, window_start)
);

CREATE INDEX idx_rate_limit_window ON rate_limit_buckets(window_start);
