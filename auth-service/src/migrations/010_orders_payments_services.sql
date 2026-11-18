CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  type_id TEXT NOT NULL,
  region_id TEXT NOT NULL,
  isp_id TEXT NOT NULL,
  spec_id TEXT,
  duration_id TEXT NOT NULL,
  catalog_version TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  currency TEXT NOT NULL CHECK(currency = 'CNY'),
  contact TEXT NOT NULL,
  scenarios TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_ref),
  UNIQUE(idempotency_key)
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  out_trade_no TEXT NOT NULL,
  channel TEXT NOT NULL CHECK(channel = 'alipay_page'),
  app_id TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  currency TEXT NOT NULL CHECK(currency = 'CNY'),
  status TEXT NOT NULL CHECK(status IN ('pending','paid','closed')),
  trade_no TEXT,
  alipay_trade_status TEXT,
  last_queried_at TEXT,
  close_reason TEXT,
  paid_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(order_id),
  UNIQUE(out_trade_no),
  UNIQUE(trade_no),
  CHECK (
    (status = 'pending' AND paid_at IS NULL AND closed_at IS NULL AND close_reason IS NULL) OR
    (status = 'paid' AND trade_no IS NOT NULL AND paid_at IS NOT NULL AND closed_at IS NULL AND close_reason IS NULL) OR
    (status = 'closed' AND paid_at IS NULL AND closed_at IS NOT NULL AND close_reason = 'alipay_trade_closed')
  )
);

CREATE INDEX idx_payments_status ON payments(status);

CREATE TABLE payment_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  notify_id TEXT NOT NULL,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  out_trade_no TEXT NOT NULL,
  trade_no TEXT NOT NULL,
  trade_status TEXT NOT NULL,
  total_amount TEXT NOT NULL,
  payload_hash TEXT,
  received_at TEXT NOT NULL,
  UNIQUE(notify_id)
);

CREATE INDEX idx_notifications_payment ON payment_notifications(payment_id);

CREATE TABLE services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK(status IN ('pending_open','open')),
  opened_by_admin_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  opened_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(payment_id),
  CHECK (
    (status = 'pending_open' AND opened_at IS NULL AND opened_by_admin_id IS NULL) OR
    (status = 'open' AND opened_at IS NOT NULL AND opened_by_admin_id IS NOT NULL)
  )
);

CREATE INDEX idx_services_status ON services(status);

CREATE TABLE order_access_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  token_hash TEXT NOT NULL,
  token_key_version INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(order_id),
  UNIQUE(token_hash)
);

CREATE INDEX idx_order_access_tokens_expiry ON order_access_tokens(expires_at);
