-- Wallet/renewal candidate accounting tables. Additive only: no existing
-- orders/payments/services/sellable_plans columns are touched and no money
-- movement is implied — balances are internal accounting rows. Ledger and
-- consent-history tables are append-only via immutability triggers.

CREATE TABLE wallet_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  balance_fen INTEGER NOT NULL DEFAULT 0 CHECK(balance_fen >= 0)
);

CREATE TABLE wallet_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('TOPUP','RENEWAL_DEBIT','REFUND_REVERSAL')),
  amount_fen INTEGER NOT NULL CHECK(
    amount_fen != 0 AND (
      (kind IN ('TOPUP','REFUND_REVERSAL') AND amount_fen > 0) OR
      (kind = 'RENEWAL_DEBIT' AND amount_fen < 0)
    )
  ),
  source_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TRIGGER wallet_ledger_no_update BEFORE UPDATE ON wallet_ledger
  BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER wallet_ledger_no_delete BEFORE DELETE ON wallet_ledger
  BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;

CREATE TABLE wallet_topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  order_ref TEXT NOT NULL UNIQUE,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  currency TEXT NOT NULL CHECK(currency = 'CNY'),
  provider_trade_no TEXT UNIQUE,
  credited_at TEXT
);

CREATE TABLE wallet_consents (
  service_id INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('DISABLED','ENABLED','RECONSENT_REQUIRED')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  quote_key TEXT,
  price_fen INTEGER CHECK(price_fen IS NULL OR price_fen > 0),
  duration_id TEXT,
  next_billing_period TEXT CHECK(
    next_billing_period IS NULL OR
    next_billing_period IN ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL')
  ),
  updated_at TEXT NOT NULL
);

CREATE TABLE wallet_consent_history (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  state TEXT NOT NULL,
  quote_key TEXT,
  price_fen INTEGER,
  duration_id TEXT,
  next_billing_period TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(service_id, revision)
);
CREATE TRIGGER wallet_consent_history_no_update BEFORE UPDATE ON wallet_consent_history
  BEGIN SELECT RAISE(ABORT,'immutable consent history'); END;
CREATE TRIGGER wallet_consent_history_no_delete BEFORE DELETE ON wallet_consent_history
  BEGIN SELECT RAISE(ABORT,'immutable consent history'); END;

CREATE TABLE wallet_renewal_cycles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  previous_ends_at TEXT NOT NULL,
  new_ends_at TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  quote_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(service_id, previous_ends_at)
);

CREATE TABLE wallet_order_closures (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  closed_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  closed_at TEXT NOT NULL,
  inventory_released INTEGER NOT NULL DEFAULT 0 CHECK(inventory_released IN (0,1)),
  coupon_released INTEGER NOT NULL DEFAULT 0 CHECK(coupon_released IN (0,1))
);

CREATE TABLE wallet_order_settlements (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE RESTRICT,
  provider_trade_no TEXT NOT NULL UNIQUE,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  state TEXT NOT NULL CHECK(state IN ('PAID','PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING')),
  recorded_at TEXT NOT NULL
);

CREATE TABLE wallet_termination_cases (
  service_id INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE RESTRICT,
  requested_at TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stop_state TEXT NOT NULL CHECK(
    stop_state IN ('REQUESTED','ACTUAL_STOP_CONFIRMED','FAILED','UNKNOWN')
  )
);

CREATE TABLE wallet_refund_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  refund_state TEXT NOT NULL CHECK(
    refund_state IN ('AWAITING_POLICY','PROCESSING','SUCCESS','FAILED','UNKNOWN')
  ),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('ORIGINAL_PAYMENT','WALLET_RENEWAL')),
  source_id INTEGER NOT NULL,
  UNIQUE(source_kind, source_id)
);

CREATE TABLE wallet_refund_reversals (
  refund_key TEXT PRIMARY KEY,
  cycle_id INTEGER NOT NULL REFERENCES wallet_renewal_cycles(id) ON DELETE RESTRICT,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  created_at TEXT NOT NULL
);
