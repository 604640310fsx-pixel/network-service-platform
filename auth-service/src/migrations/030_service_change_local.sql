-- Local service-change demo: historical services have no entitlement row and are never quotable.
CREATE TABLE service_entitlements (
  service_id INTEGER PRIMARY KEY REFERENCES services(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  plan_id INTEGER NOT NULL REFERENCES sellable_plans(id) ON DELETE RESTRICT,
  monthly_plan_id INTEGER NOT NULL REFERENCES sellable_plans(id) ON DELETE RESTRICT,
  monthly_price_fen INTEGER NOT NULL CHECK(monthly_price_fen > 0),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  period_months INTEGER NOT NULL CHECK(period_months IN (1,6,12)),
  discount_numerator INTEGER NOT NULL,
  discount_denominator INTEGER NOT NULL,
  usage_start TEXT NOT NULL,
  usage_end TEXT NOT NULL,
  usage_used_gb INTEGER NOT NULL CHECK(usage_used_gb >= 0),
  usage_quota_gb INTEGER NOT NULL CHECK(usage_quota_gb > 0),
  usage_version INTEGER NOT NULL DEFAULT 1 CHECK(usage_version > 0),
  provider_binding_ref TEXT NOT NULL CHECK(length(provider_binding_ref) > 0),
  binding_provenance TEXT NOT NULL CHECK(binding_provenance IN ('synthetic','verified_opening')),
  version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(period_end > period_start),
  CHECK(usage_end > usage_start)
);
CREATE INDEX idx_service_entitlements_user ON service_entitlements(user_id);

CREATE TABLE service_change_quotes (
  quote_ref TEXT PRIMARY KEY,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  service_version INTEGER NOT NULL,
  usage_version INTEGER NOT NULL,
  target_plan_id INTEGER NOT NULL REFERENCES sellable_plans(id) ON DELETE RESTRICT,
  target_monthly_plan_id INTEGER NOT NULL REFERENCES sellable_plans(id) ON DELETE RESTRICT,
  target_monthly_fen INTEGER NOT NULL CHECK(target_monthly_fen > 0),
  amount_fen INTEGER NOT NULL CHECK(amount_fen > 0),
  quoted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  CHECK(expires_at > quoted_at)
);
CREATE INDEX idx_service_change_quotes_service ON service_change_quotes(service_id);

CREATE TABLE service_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('upgrade','downgrade')),
  status TEXT NOT NULL CHECK(status IN ('pending_payment','pending_fulfillment','fulfillment_failed','paid_conflict','applied','scheduled','cancelled','closed')),
  order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  quote_ref TEXT UNIQUE REFERENCES service_change_quotes(quote_ref) ON DELETE RESTRICT,
  from_version INTEGER NOT NULL,
  target_plan_id INTEGER NOT NULL REFERENCES sellable_plans(id) ON DELETE RESTRICT,
  target_monthly_plan_id INTEGER NOT NULL REFERENCES sellable_plans(id) ON DELETE RESTRICT,
  target_monthly_fen INTEGER NOT NULL CHECK(target_monthly_fen > 0),
  amount_fen INTEGER NOT NULL CHECK(amount_fen >= 0),
  effective_at TEXT,
  receipt_ref TEXT UNIQUE,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((kind = 'upgrade' AND order_id IS NOT NULL AND amount_fen > 0) OR
        (kind = 'downgrade' AND order_id IS NULL AND amount_fen = 0)),
  CHECK((status = 'applied' AND effective_at IS NOT NULL AND receipt_ref IS NOT NULL) OR status != 'applied')
);
CREATE UNIQUE INDEX idx_service_change_one_active ON service_changes(service_id)
  WHERE status IN ('pending_payment','pending_fulfillment','fulfillment_failed','scheduled');
CREATE INDEX idx_service_changes_user ON service_changes(user_id, service_id);
