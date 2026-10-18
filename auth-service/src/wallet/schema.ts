/** Isolated candidate schema. Only tests may apply this DDL; migration 025 is owned elsewhere. */
/* States in which a renewal operation is still unresolved: occupies the live
   uniqueness slot and blocks fresh attempts for its (service, prior expiry).
   Shared by the fixture runner and the TEST_ONLY operations module so both
   enforce the same set — a single literal source, not two copies. */
export const WALLET_RENEWAL_LIVE_STATES_SQL =
  "('HOLD_ACTIVE','DISPATCH_AUTHORIZED','EVIDENCE_RECORDED','CONFLICT')";
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
/* TEST_ONLY modeled renewal execution (hold-first, external-extension-confirmed).
   Fixture-only like wallet_service_extensions: no production DDL, scheduler,
   provider call, real hold or settlement is implied by these tables.
   Operation intent columns are written once at reserve and never updated;
   dispatch/evidence transition columns are the only mutable part. */
CREATE TABLE wallet_renewal_operations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
  intended_previous_ends_at TEXT NOT NULL, intended_new_ends_at TEXT NOT NULL,
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency='CNY'),
  duration_id TEXT NOT NULL, quote_key TEXT NOT NULL, consent_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('HOLD_ACTIVE','DISPATCH_AUTHORIZED','EVIDENCE_RECORDED','COMPLETED','CANCELLED','RELEASED','CONFLICT')),
  dispatch_id TEXT, dispatch_anchor_at TEXT,
  evidence_id INTEGER, cycle_id INTEGER,
  conflict_detail TEXT, escalation_due_at TEXT,
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE UNIQUE INDEX idx_wallet_renewal_ops_live
  ON wallet_renewal_operations(service_id, intended_previous_ends_at)
  WHERE state IN ('HOLD_ACTIVE','DISPATCH_AUTHORIZED','EVIDENCE_RECORDED','CONFLICT');
CREATE UNIQUE INDEX idx_wallet_renewal_ops_dispatch
  ON wallet_renewal_operations(dispatch_id) WHERE dispatch_id IS NOT NULL;
CREATE TABLE wallet_renewal_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL UNIQUE,
  user_id INTEGER NOT NULL, amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  state TEXT NOT NULL CHECK(state IN ('ACTIVE','CAPTURED','RELEASED')),
  created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE TABLE wallet_renewal_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL UNIQUE,
  dispatch_id TEXT NOT NULL, resource_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('APPLIED','NO_EFFECT','REJECTED')),
  term_ends_at TEXT, source_ref TEXT NOT NULL, recorded_at TEXT NOT NULL
);
/* Append-only log of contradictory/late external claims. A claim against an
   operation whose state is terminal must never resurrect that row into the
   live-uniqueness set — the fact persists here while the operation keeps its
   terminal state, and any later operation on the same (service, prior expiry)
   is refused until owner reconciliation. No automatic money disposition. */
CREATE TABLE wallet_renewal_contradictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL,
  dispatch_id TEXT NOT NULL, resource_key TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('APPLIED','NO_EFFECT','REJECTED')),
  term_ends_at TEXT, source_ref TEXT NOT NULL,
  detail TEXT NOT NULL, recorded_at TEXT NOT NULL
);
`;
