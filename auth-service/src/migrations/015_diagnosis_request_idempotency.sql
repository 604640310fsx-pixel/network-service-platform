CREATE TABLE diagnosis_request_idempotency (
  idempotency_key TEXT NOT NULL PRIMARY KEY,
  diagnosis_request_id INTEGER NOT NULL UNIQUE
    REFERENCES diagnosis_requests(id)
    ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  CHECK (
    length(idempotency_key) = 36
    AND idempotency_key = lower(idempotency_key)
    AND substr(idempotency_key, 9, 1) = '-'
    AND substr(idempotency_key, 14, 1) = '-'
    AND substr(idempotency_key, 19, 1) = '-'
    AND substr(idempotency_key, 24, 1) = '-'
    AND substr(idempotency_key, 15, 1) = '4'
    AND substr(idempotency_key, 20, 1) IN ('8', '9', 'a', 'b')
    AND replace(idempotency_key, '-', '') NOT GLOB '*[^0-9a-f]*'
  )
);
