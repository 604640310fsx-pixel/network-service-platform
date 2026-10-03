import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { DatabaseConnection } from "../../src/db.js";
import { WALLET_CANDIDATE_TEST_SCHEMA } from "../../src/wallet/schema.js";
import {
  assertOrderOpenForAction, cancelPendingOrder, createTopupIntent, creditVerifiedTopup,
  produceRenewalQuote, recordWalletReversalFixture, recordVerifiedOrderPayment, renewalDryRun, requestPaidServiceTermination,
  runRenewalFixture, setNextBillingPeriod, setRenewalConsent, walletBalance, type AuthoritativeQuote, type ManagedOrder, type ServiceEligibility,
} from "../../src/wallet/candidate.js";

const require = createRequire(import.meta.url);
const Sqlite = require("better-sqlite3") as new (path: string) => DatabaseConnection;
const AT = "2026-10-04T00:00:00.000Z";
function fixture(fn: (db: DatabaseConnection) => void): void {
  const db = new Sqlite(":memory:");
  try {
    db.exec(WALLET_CANDIDATE_TEST_SCHEMA);
    db.prepare(`INSERT INTO orders(id,user_id,status,type_id,region_id,isp_id,spec_id,duration_id,catalog_version)
      VALUES (1,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1')`).run();
    db.prepare("INSERT INTO payments(id,order_id,status) VALUES (1,1,'paid')").run();
    db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (11,1,?)").run("2026-11-01T00:00:00.000Z");
    db.prepare(`INSERT INTO sellable_plans(id,type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,created_at,updated_at)
      VALUES (1,'local-isp','us','us-verizon',NULL,'month-1',900,1,?,?),
             (2,'local-isp','us','us-verizon',NULL,'month-6',5000,1,?,?),
             (3,'local-isp','us','us-verizon',NULL,'month-12',9000,1,?,?)`).run(AT, AT, AT, AT, AT, AT);
    fn(db);
  } finally { db.close(); }
}
function count(db: DatabaseConnection, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number }).n;
}
function state(db: DatabaseConnection, serviceId: number): string {
  return (db.prepare("SELECT state FROM wallet_consents WHERE service_id=?").all(serviceId)[0] as { state: string }).state;
}
const service: ServiceEligibility = { serviceId: 11, ownerId: 7, purchased: true, endsAt: "2026-11-01T00:00:00.000Z" };
const quote: AuthoritativeQuote = { key: "renewal-quote:SUBSCRIBE-CATALOG-V1:local-isp:us:us-verizon::month-1:900",
  serviceId: 11, ownerId: 7,
  priceFen: 900, durationId: "month-1", period: "MONTHLY",
  previousEndsAt: service.endsAt!, newEndsAt: "2026-12-01T00:00:00.000Z" };
function topup(db: DatabaseConnection, orderRef = "t-1", amountFen = 1000): void {
  db.prepare("INSERT INTO wallet_topups(user_id,order_ref,amount_fen,currency) VALUES (7,?,?,'CNY')").run(orderRef, amountFen);
}
function credit(db: DatabaseConnection, orderRef = "t-1", trade = "trade-1", amountFen = 1000) {
  return creditVerifiedTopup(db, "merchant-1", { orderRef, providerTradeNo: trade, merchantId: "merchant-1",
    amountFen, currency: "CNY", finalStatus: "SUCCESS", signatureVerified: true }, AT);
}
function consent(db: DatabaseConnection): number { return setRenewalConsent(db, 11, 7, "MONTHLY", 0, true, AT); }

test("missing wallet is zero; SQL failure remains unknown, and verified credit is atomic and idempotent", () => fixture((db) => {
  assert.equal(walletBalance(db, 7), 0);
  const actor = { userId: 7, sessionValid: true, csrfValid: true, isAdmin: false };
  assert.throws(() => createTopupIntent(db, { ...actor, csrfValid: false }, "t-1", 1000), /UNAUTHORIZED/);
  assert.equal(createTopupIntent(db, actor, "t-1", 1000), "CREATED");
  assert.equal(createTopupIntent(db, actor, "t-1", 1000), "REPLAY");
  assert.throws(() => createTopupIntent(db, { ...actor, userId: 8 }, "t-1", 1000), /TOPUP_MISMATCH/);
  assert.throws(() => creditVerifiedTopup(db, "merchant-1", { orderRef: "t-1", providerTradeNo: "trade-1",
    merchantId: "wrong", amountFen: 1000, currency: "CNY", finalStatus: "SUCCESS", signatureVerified: true }, AT), /VERIFICATION_REQUIRED/);
  assert.equal(walletBalance(db, 7), 0);
  assert.equal(credit(db), "CREDITED");
  assert.equal(credit(db), "REPLAY");
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(count(db, "wallet_ledger"), 1);
  topup(db, "t-2");
  assert.throws(() => credit(db, "t-2", "trade-1"), /UNIQUE/);
  assert.equal(count(db, "wallet_ledger"), 1);
  db.exec("DROP TABLE wallet_accounts");
  assert.throws(() => walletBalance(db, 7));
}));

test("quote and owner are required; gift, missing end, missing plan and changed quote cannot debit", () => fixture((db) => {
  assert.throws(() => setRenewalConsent(db, 12, 7, "MONTHLY", 0, true, AT), /QUOTE_UNAVAILABLE/);
  db.prepare("UPDATE services SET ends_at=NULL WHERE id=11").run();
  assert.throws(() => setRenewalConsent(db, 11, 7, "MONTHLY", 0, true, AT), /QUOTE_UNAVAILABLE/);
  db.prepare("UPDATE services SET ends_at='2026-11-01T00:00:00.000Z' WHERE id=11").run();
  assert.throws(() => setRenewalConsent(db, 11, 8, "MONTHLY", 0, true, AT), /FORBIDDEN/);
  assert.throws(() => setRenewalConsent(db, 11, 7, "QUARTERLY", 0, true, AT), /QUOTE_UNAVAILABLE/);
  consent(db);
  assert.equal(renewalDryRun(db, service, { ...quote, priceFen: 901 }), "RECONSENT_REQUIRED");
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, { ...quote, priceFen: 901 }, 1, AT), "RECONSENT_REQUIRED");
  assert.equal(state(db, 11), "RECONSENT_REQUIRED");
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
}));

test("debit, ledger, cycle and modeled extension commit together or roll back together", () => fixture((db) => {
  topup(db); credit(db); consent(db);
  db.exec(`CREATE TRIGGER fail_extension BEFORE INSERT ON wallet_service_extensions BEGIN SELECT RAISE(ABORT,'extension failed'); END;`);
  assert.throws(() => runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), /extension failed/);
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_ledger"), 1);
  db.exec("DROP TRIGGER fail_extension");
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "COMMITTED");
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
  assert.equal(walletBalance(db, 7), 100);
  assert.equal(count(db, "wallet_renewal_cycles"), 1);
  assert.equal(count(db, "wallet_ledger"), 2);
  assert.throws(() => db.prepare("DELETE FROM wallet_ledger").run(), /immutable ledger/);
  assert.throws(() => setRenewalConsent(db, 11, 7, "MONTHLY", 0, false, AT), /REVISION_CONFLICT/);
}));

test("period change serializes with runner and forces renewed consent; disabling stays off", () => fixture((db) => {
  const actor = { userId: 7, sessionValid: true, csrfValid: true, isAdmin: false };
  topup(db); credit(db); consent(db);
  // QUARTERLY has no month-3 SKU for this tuple: the current sellable quote check rejects it.
  assert.throws(() => setNextBillingPeriod(db, actor, 11, "QUARTERLY", 1, AT), /QUOTE_UNAVAILABLE/);
  assert.equal(setNextBillingPeriod(db, actor, 11, "SEMIANNUAL", 1, AT), 2);
  assert.equal(state(db, 11), "RECONSENT_REQUIRED");
  assert.throws(() => runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), /REVISION_CONFLICT/);
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 2, AT), "RECONSENT_REQUIRED");
  assert.equal(walletBalance(db, 7), 1000);
  db.prepare("UPDATE services SET ends_at=NULL WHERE id=11").run();
  setRenewalConsent(db, 11, 7, "MONTHLY", 2, false, AT);
  // Null expiry makes the quote unavailable even for a DISABLED row (frozen: unavailable quote → reject).
  assert.throws(() => setNextBillingPeriod(db, actor, 11, "ANNUAL", 3, AT), /QUOTE_UNAVAILABLE/);
  db.prepare("UPDATE services SET ends_at='2026-11-01T00:00:00.000Z' WHERE id=11").run();
  setNextBillingPeriod(db, actor, 11, "ANNUAL", 3, AT);
  assert.equal(state(db, 11), "DISABLED");
  assert.equal(count(db, "wallet_consent_history"), 4);
}));

test("cancel boundary: owner/admin, CSRF, release once, paid-first and late paid anomaly", () => fixture((db) => {
  const actor = { userId: 7, sessionValid: true, csrfValid: true, isAdmin: false };
  const order = { id: 31, ownerId: 7, status: "pending" as const, paymentStatus: "pending" as const, confirmed: false };
  db.prepare("INSERT INTO orders(id,user_id,status) VALUES (31,7,'pending'),(32,7,'pending')").run();
  db.prepare("INSERT INTO payments(id,order_id,status,amount_fen,currency) VALUES (31,31,'pending',800,'CNY'),(32,32,'pending',800,'CNY')").run();
  db.exec("CREATE TABLE releases (kind TEXT NOT NULL)");
  db.exec("CREATE TABLE fulfillments (order_id INTEGER NOT NULL)");
  const load = (_db: DatabaseConnection, id: number) => ({ ...order, id });
  const release = (database: DatabaseConnection, _order: ManagedOrder, kind: "inventory" | "coupon") => {
    database.prepare("INSERT INTO releases(kind) VALUES (?)").run(kind);
  };
  const fulfill = (database: DatabaseConnection, id: number) => { database.prepare("INSERT INTO fulfillments(order_id) VALUES (?)").run(id); };
  const event = (id: number, trade: string) => ({ orderId: id, providerTradeNo: trade, amountFen: 800,
    merchantId: "merchant-1", currency: "CNY" as const, finalStatus: "SUCCESS" as const, signatureVerified: true as const });
  assert.throws(() => cancelPendingOrder(db, { ...actor, csrfValid: false }, 31, AT, load, release), /UNAUTHORIZED/);
  assert.throws(() => cancelPendingOrder(db, { ...actor, userId: 8 }, 31, AT, load, release), /FORBIDDEN/);
  assert.throws(() => cancelPendingOrder(db, actor, 31, AT, load, (database, current, kind) => {
    release(database, current, kind); if (kind === "coupon") throw new Error("release failed");
  }), /release failed/);
  assert.equal(count(db, "releases"), 0);
  assert.equal(count(db, "wallet_order_closures"), 0);
  assert.equal(cancelPendingOrder(db, actor, 31, AT, load, release), "CANCELLED");
  assert.equal(cancelPendingOrder(db, actor, 31, AT, load, release), "ALREADY_CANCELLED");
  assert.equal(count(db, "releases"), 2);
  assert.throws(() => assertOrderOpenForAction(db, 31), /MANAGEMENT_CLOSED/);
  assert.throws(() => recordVerifiedOrderPayment(db, "merchant-1", { ...event(31, "trade-late"), merchantId: "wrong" }, AT, fulfill), /VERIFICATION_REQUIRED/);
  assert.throws(() => recordVerifiedOrderPayment(db, "merchant-1", { ...event(31, "trade-late"), amountFen: 801 }, AT, fulfill), /PAYMENT_MISMATCH/);
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(31, "trade-late"), AT, fulfill), "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING");
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(31, "trade-late"), AT, fulfill), "REPLAY");
  assert.equal(count(db, "fulfillments"), 0);
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(32, "trade-first"), AT, fulfill), "PAID");
  assert.throws(() => cancelPendingOrder(db, actor, 32, AT, load, release), /NOT_CANCELLABLE/);
  assert.equal(count(db, "fulfillments"), 1);
  assert.equal(count(db, "wallet_order_settlements"), 2);
}));

test("real closed rows without management closure retain late-paid fact; existing paid rows never fulfill twice", () => fixture((db) => {
  db.prepare("INSERT INTO orders(id,user_id,status) VALUES (41,7,'closed'),(42,7,'pending'),(43,7,'paid'),(44,7,'paid'),(45,7,'closed'),(46,7,'paid')").run();
  db.prepare(`INSERT INTO payments(id,order_id,status,amount_fen,currency,trade_no) VALUES
    (41,41,'closed',800,'CNY',NULL),(42,42,'closed',800,'CNY',NULL),
    (43,43,'paid',800,'CNY','trade-43'),(44,44,'paid',800,'CNY','trade-44'),
    (45,45,'paid',800,'CNY','trade-45'),(46,46,'pending',800,'CNY',NULL)`).run();
  db.prepare("INSERT INTO wallet_order_closures(order_id,closed_by_user_id,closed_at) VALUES (44,7,?)").run(AT);
  db.exec("CREATE TABLE fulfillments (order_id INTEGER NOT NULL)");
  const fulfill = (database: DatabaseConnection, id: number) => { database.prepare("INSERT INTO fulfillments(order_id) VALUES (?)").run(id); };
  const event = (id: number) => ({ orderId: id, providerTradeNo: `trade-${id}`, amountFen: 800,
    merchantId: "merchant-1", currency: "CNY" as const, finalStatus: "SUCCESS" as const, signatureVerified: true as const });
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(41), AT, fulfill), "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING");
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(42), AT, fulfill), "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING");
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(43), AT, fulfill), "REPLAY");
  assert.throws(() => recordVerifiedOrderPayment(db, "merchant-1", { ...event(43), providerTradeNo: "other-trade" }, AT, fulfill), /TRADE_CONFLICT/);
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(44), AT, fulfill), "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING");
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(45), AT, fulfill), "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING");
  assert.throws(() => recordVerifiedOrderPayment(db, "merchant-1", event(46), AT, fulfill), /PAYMENT_STATE_CONFLICT/);
  assert.equal(count(db, "fulfillments"), 0);
  assert.deepEqual(db.prepare("SELECT state FROM wallet_order_settlements ORDER BY order_id").all(), [
    { state: "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" }, { state: "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" },
    { state: "PAID" }, { state: "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" },
    { state: "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING" },
  ]);
  assert.equal(recordVerifiedOrderPayment(db, "merchant-1", event(41), AT, fulfill), "REPLAY");
  assert.equal(count(db, "wallet_order_settlements"), 5);
}));

test("refund case separates actual stop from policy; wallet reversal is bounded and idempotent", () => fixture((db) => {
  topup(db); credit(db); consent(db); runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT);
  const admin = { userId: 99, sessionValid: true, csrfValid: true, isAdmin: true };
  assert.throws(() => requestPaidServiceTermination(db, { ...admin, isAdmin: false }, 11, "WALLET_RENEWAL", 1, AT), /FORBIDDEN/);
  assert.throws(() => requestPaidServiceTermination(db, admin, 11, "ORIGINAL_PAYMENT", 999, AT), /SOURCE_UNAVAILABLE/);
  requestPaidServiceTermination(db, admin, 11, "WALLET_RENEWAL", 1, AT);
  db.prepare(`INSERT INTO wallet_renewal_cycles(service_id,previous_ends_at,new_ends_at,user_id,amount_fen,quote_key,created_at)
    VALUES (11,'2026-12-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',7,900,'server-snapshot-2',?)`).run(AT);
  requestPaidServiceTermination(db, admin, 11, "ORIGINAL_PAYMENT", 1, AT);
  requestPaidServiceTermination(db, admin, 11, "WALLET_RENEWAL", 2, AT);
  requestPaidServiceTermination(db, admin, 11, "WALLET_RENEWAL", 2, AT);
  assert.equal(count(db, "wallet_termination_cases"), 1);
  assert.equal(count(db, "wallet_refund_cases"), 3);
  assert.equal(count(db, "wallet_consent_history"), 2); // initial consent and one disable only
  assert.equal(state(db, 11), "DISABLED");
  const termination = db.prepare(`SELECT t.stop_state,r.refund_state,r.source_kind FROM wallet_termination_cases t
    JOIN wallet_refund_cases r ON r.service_id=t.service_id
    WHERE t.service_id=11 AND r.source_kind='WALLET_RENEWAL' AND r.source_id=1`).all()[0];
  assert.deepEqual(termination, { stop_state: "REQUESTED", refund_state: "AWAITING_POLICY", source_kind: "WALLET_RENEWAL" });
  assert.throws(() => recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 900, AT), /REFUND_NOT_PROCESSING/);
  db.prepare("UPDATE wallet_refund_cases SET refund_state='PROCESSING' WHERE source_kind='WALLET_RENEWAL' AND source_id=1").run(); // isolated approved-policy fixture only
  assert.throws(() => recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 0, AT), /POLICY_REQUIRED/);
  assert.equal(recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 900, AT), "RECORDED");
  assert.equal(recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 900, AT), "REPLAY");
  assert.throws(() => recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-2", 500, 900, AT), /REFUND_EXCEEDS_PAID/);
  assert.equal(walletBalance(db, 7), 600);
  assert.equal(count(db, "wallet_refund_reversals"), 1);
}));

test("renewal quote is server-derived from the paid order tuple and live plan; every gap fails closed", () => fixture((db) => {
  const produced = produceRenewalQuote(db, 11, "MONTHLY", 7);
  assert.equal(produced.serviceId, 11);
  assert.equal(produced.ownerId, 7);
  assert.equal(produced.priceFen, 900);
  assert.equal(produced.durationId, "month-1");
  assert.equal(produced.period, "MONTHLY");
  assert.equal(produced.previousEndsAt, "2026-11-01T00:00:00.000Z");
  assert.equal(produced.newEndsAt, "2026-12-01T00:00:00.000Z");
  assert.ok(produced.key.includes("SUBSCRIBE-CATALOG-V1") && produced.key.endsWith(":month-1:900"));
  assert.ok(!produced.key.includes("CATV1") && !produced.key.includes("2026-11-01"));
  // terms key binds version+tuple+price+duration only, never expiry or the old stamp
  // Derived quote is exactly what consent/dry-run accept.
  assert.equal(renewalDryRun(db, service, produced), "DISABLED");
  // Same instant in a non-canonical stored form must not conflict with the quote.
  db.prepare("UPDATE services SET ends_at='2026-11-01T00:00:00Z' WHERE id=11").run();
  const normalized = produceRenewalQuote(db, 11, "MONTHLY", 7);
  assert.equal(normalized.previousEndsAt, "2026-11-01T00:00:00.000Z");
  assert.equal(renewalDryRun(db, service, normalized), "DISABLED");
  db.prepare("UPDATE services SET ends_at='2026-11-01T00:00:00.000Z' WHERE id=11").run();
  // Missing catalog duration for the tuple.
  assert.throws(() => produceRenewalQuote(db, 11, "QUARTERLY", 7), /QUOTE_UNAVAILABLE/);
  // Inactive plan row.
  db.prepare("UPDATE sellable_plans SET is_active=0 WHERE id=1").run();
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 7), /QUOTE_UNAVAILABLE/);
  db.prepare("UPDATE sellable_plans SET is_active=1 WHERE id=1").run();
  // Ambiguous SKU (duplicate 5-tuple row) fails closed, not a guess.
  db.prepare(`INSERT INTO sellable_plans(id,type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,created_at,updated_at)
    VALUES (92,'local-isp','us','us-verizon',NULL,'month-1',901,1,?,?)`).run(AT, AT);
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 7), /QUOTE_UNAVAILABLE/);
  db.prepare("DELETE FROM sellable_plans WHERE id=92").run();
  // No paid source (gift-style service) has no order join.
  db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (12,99,?)").run("2026-12-01T00:00:00.000Z");
  assert.throws(() => produceRenewalQuote(db, 12, "MONTHLY", 7), /QUOTE_UNAVAILABLE/);
  // Null / malformed expiry.
  db.prepare("UPDATE services SET ends_at=NULL WHERE id=11").run();
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 7), /QUOTE_UNAVAILABLE/);
  db.prepare("UPDATE services SET ends_at='not-a-date' WHERE id=11").run();
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 7), /QUOTE_UNAVAILABLE/);
}));

test("reprice after consent fails closed inside the deduction transaction: no debit, reconsent marked", () => fixture((db) => {
  topup(db); credit(db); consent(db);
  db.prepare("UPDATE sellable_plans SET price_fen=950 WHERE id=1").run();
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "RECONSENT_REQUIRED");
  assert.equal(state(db, 11), "RECONSENT_REQUIRED");
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_service_extensions"), 0);
}));

test("deactivated plan after consent fails closed inside the deduction transaction", () => fixture((db) => {
  topup(db); credit(db); consent(db);
  db.prepare("UPDATE sellable_plans SET is_active=0 WHERE id=1").run();
  assert.throws(() => runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), /QUOTE_UNAVAILABLE/);
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
}));

test("crafted caller fields are never consumed: consent stores produced values, runner commits produced values", () => fixture((db) => {
  topup(db); credit(db);
  setRenewalConsent(db, 11, 7, "MONTHLY", 0, true, AT);
  const stored = db.prepare("SELECT quote_key,price_fen,duration_id FROM wallet_consents WHERE service_id=11")
    .all()[0] as { quote_key: string; price_fen: number; duration_id: string };
  assert.equal(stored.price_fen, 900);
  assert.equal(stored.duration_id, "month-1");
  assert.equal(stored.quote_key, quote.key);
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "COMMITTED");
  assert.equal(walletBalance(db, 7), 100);
  const ext = db.prepare("SELECT modeled_ends_at FROM wallet_service_extensions WHERE service_id=11")
    .all()[0] as { modeled_ends_at: string };
  assert.equal(ext.modeled_ends_at, "2026-12-01T00:00:00.000Z");
  const cycle = db.prepare("SELECT amount_fen,new_ends_at FROM wallet_renewal_cycles WHERE service_id=11")
    .all()[0] as { amount_fen: number; new_ends_at: string };
  assert.equal(cycle.amount_fen, 900);
  assert.equal(cycle.new_ends_at, "2026-12-01T00:00:00.000Z");
}));

test("genuine key with hostile caller fields cannot reach READY: zero debit, zero extension, reconsent marked", () => fixture((db) => {
  topup(db); credit(db); consent(db);
  const crafted: AuthoritativeQuote = { ...quote, priceFen: 1, newEndsAt: "2099-01-01T00:00:00.000Z" };
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, crafted, 1, AT), "RECONSENT_REQUIRED");
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_service_extensions"), 0);
}));

test("producer owner gate: non-owner cannot obtain the quote", () => fixture((db) => {
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 8), /FORBIDDEN/);
  assert.throws(() => produceRenewalQuote(db, 12, "MONTHLY", 8), /QUOTE_UNAVAILABLE/);
}));

test("same terms across successive periods need no reconsent; each cycle binds its own expiry snapshot", () => fixture((db) => {
  topup(db, "t-1", 3000); credit(db, "t-1", "trade-1", 3000); consent(db);
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "COMMITTED");
  // Local fulfillment advances the service expiry; identical terms keep the consent usable.
  db.prepare("UPDATE services SET ends_at='2026-12-01T00:00:00.000Z' WHERE id=11").run();
  const service2: ServiceEligibility = { ...service, endsAt: "2026-12-01T00:00:00.000Z" };
  const next = produceRenewalQuote(db, 11, "MONTHLY", 7);
  assert.equal(next.key, quote.key);
  assert.equal(next.previousEndsAt, "2026-12-01T00:00:00.000Z");
  assert.equal(next.newEndsAt, "2027-01-01T00:00:00.000Z");
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service2, next, 1, AT), "COMMITTED");
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service2, next, 1, AT), "DUPLICATE");
  assert.equal(walletBalance(db, 7), 1200);
  const periods = db.prepare("SELECT previous_ends_at,new_ends_at FROM wallet_renewal_cycles WHERE service_id=11 ORDER BY id")
    .all() as Array<{ previous_ends_at: string; new_ends_at: string }>;
  assert.equal(periods.length, 2);
  assert.ok(periods[0] !== undefined && periods[1] !== undefined);
  assert.equal(periods[0].previous_ends_at, "2026-11-01T00:00:00.000Z");
  assert.equal(periods[0].new_ends_at, "2026-12-01T00:00:00.000Z");
  assert.equal(periods[1].previous_ends_at, "2026-12-01T00:00:00.000Z");
  assert.equal(periods[1].new_ends_at, "2027-01-01T00:00:00.000Z");
}));

test("terms change forces reconsent or unavailability: price, owner, open status", () => fixture((db) => {
  topup(db); credit(db); consent(db);
  db.prepare("UPDATE sellable_plans SET price_fen=950 WHERE id=1").run();
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "RECONSENT_REQUIRED");
  db.prepare("UPDATE sellable_plans SET price_fen=900 WHERE id=1").run();
  db.prepare("UPDATE orders SET user_id=8 WHERE id=1").run();
  assert.equal(renewalDryRun(db, service, quote), "QUOTE_UNAVAILABLE");
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 7), /FORBIDDEN/);
  db.prepare("UPDATE orders SET user_id=7 WHERE id=1").run();
  db.prepare("UPDATE services SET status='pending_open' WHERE id=11").run();
  assert.throws(() => produceRenewalQuote(db, 11, "MONTHLY", 7), /QUOTE_UNAVAILABLE/);
}));
