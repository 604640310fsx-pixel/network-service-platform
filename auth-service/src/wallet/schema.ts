/** Isolated candidate schema. Only tests may apply this DDL; migration 025 is owned elsewhere. */
export const WALLET_CANDIDATE_TEST_SCHEMA = `
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','closed')),
  type_id TEXT, region_id TEXT, isp_id TEXT, spec_id TEXT, duration_id TEXT, catalog_version TEXT);
CREATE TABLE sellable_plans (id INTEGER PRIMARY KEY,
  type_id TEXT NOT NULL, region_id TEXT NOT NULL, isp_id TEXT NOT NULL,
  spec_id TEXT, duration_id TEXT NOT NULL, price_fen INTEGER NOT NULL CHECK(price_fen > 0),
  is_active INTEGER NOT NULL DEFAULT 1, total_slots INTEGER, occupied_slots INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE payments (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK(status IN ('pending','paid','closed')),
  amount_fen INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'CNY', trade_no TEXT);
CREATE TABLE services (id INTEGER PRIMARY KEY, payment_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('pending_open','open','closed')), ends_at TEXT);
CREATE TABLE wallet_accounts (user_id INTEGER PRIMARY KEY, balance_fen INTEGER NOT NULL DEFAULT 0 CHECK(balance_fen >= 0));
CREATE TABLE wallet_ledger (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('TOPUP','RENEWAL_DEBIT','REFUND_REVERSAL')),
  amount_fen INTEGER NOT NULL CHECK(amount_fen != 0), source_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TRIGGER wallet_ledger_no_update BEFORE UPDATE ON wallet_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TRIGGER wallet_ledger_no_delete BEFORE DELETE ON wallet_ledger BEGIN SELECT RAISE(ABORT,'immutable ledger'); END;
CREATE TABLE wallet_topups (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, order_ref TEXT NOT NULL UNIQUE,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0), currency TEXT NOT NULL CHECK(currency='CNY'),
  provider_trade_no TEXT UNIQUE, credited_at TEXT
);
CREATE TABLE wallet_consents (
  service_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('DISABLED','ENABLED','RECONSENT_REQUIRED')),
  revision INTEGER NOT NULL CHECK(revision >= 0), quote_key TEXT, price_fen INTEGER, duration_id TEXT,
  next_billing_period TEXT CHECK(next_billing_period IN ('MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL')),
  updated_at TEXT NOT NULL
);
CREATE TABLE wallet_consent_history (
  service_id INTEGER NOT NULL, revision INTEGER NOT NULL, user_id INTEGER NOT NULL,
  state TEXT NOT NULL, quote_key TEXT, price_fen INTEGER, duration_id TEXT,
  next_billing_period TEXT, created_at TEXT NOT NULL, PRIMARY KEY(service_id,revision)
);
CREATE TRIGGER wallet_consent_history_no_update BEFORE UPDATE ON wallet_consent_history BEGIN SELECT RAISE(ABORT,'immutable consent history'); END;
CREATE TRIGGER wallet_consent_history_no_delete BEFORE DELETE ON wallet_consent_history BEGIN SELECT RAISE(ABORT,'immutable consent history'); END;
CREATE TABLE wallet_renewal_cycles (
  id INTEGER PRIMARY KEY, service_id INTEGER NOT NULL, previous_ends_at TEXT NOT NULL,
  new_ends_at TEXT NOT NULL, user_id INTEGER NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  quote_key TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(service_id,previous_ends_at)
);
CREATE TABLE wallet_service_extensions (service_id INTEGER PRIMARY KEY, modeled_ends_at TEXT NOT NULL);
CREATE TABLE wallet_order_closures (
  order_id INTEGER PRIMARY KEY, closed_by_user_id INTEGER NOT NULL, closed_at TEXT NOT NULL,
  inventory_released INTEGER NOT NULL DEFAULT 0 CHECK(inventory_released IN (0,1)),
  coupon_released INTEGER NOT NULL DEFAULT 0 CHECK(coupon_released IN (0,1))
);
CREATE TABLE wallet_order_settlements (
  order_id INTEGER PRIMARY KEY, provider_trade_no TEXT NOT NULL UNIQUE, amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  state TEXT NOT NULL CHECK(state IN ('PAID','PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING')),
  recorded_at TEXT NOT NULL
);
CREATE TABLE wallet_termination_cases (
  service_id INTEGER PRIMARY KEY, requested_at TEXT NOT NULL, requested_by INTEGER NOT NULL,
  stop_state TEXT NOT NULL CHECK(stop_state IN ('REQUESTED','ACTUAL_STOP_CONFIRMED','FAILED','UNKNOWN'))
);
CREATE TABLE wallet_refund_cases (
  id INTEGER PRIMARY KEY, service_id INTEGER,
  refund_state TEXT NOT NULL CHECK(refund_state IN ('AWAITING_POLICY','PROCESSING','SUCCESS','FAILED','UNKNOWN')),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('ORIGINAL_PAYMENT','WALLET_RENEWAL')),
  source_id INTEGER NOT NULL, UNIQUE(source_kind,source_id),
  CHECK(source_kind='ORIGINAL_PAYMENT' OR service_id IS NOT NULL)
);
CREATE TABLE wallet_refund_reversals (
  refund_key TEXT PRIMARY KEY, cycle_id INTEGER NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  created_at TEXT NOT NULL
);
`;
