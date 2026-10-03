import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { DatabaseConnection } from "../../src/db.js";
import { WALLET_CANDIDATE_TEST_SCHEMA } from "../../src/wallet/schema.js";
import {
  assertOrderOpenForAction, cancelPendingOrder, changeNextBillingPeriod, createTopupIntent, creditVerifiedTopup,
  recordWalletReversalFixture, recordVerifiedOrderPayment, renewalDryRun, requestPaidServiceTermination,
  runRenewalFixture, setRenewalConsent, walletBalance, type AuthoritativeQuote, type ManagedOrder, type ServiceEligibility,
} from "../../src/wallet/candidate.js";

const require = createRequire(import.meta.url);
const Sqlite = require("better-sqlite3") as new (path: string) => DatabaseConnection;
const AT = "2026-10-04T00:00:00.000Z";
function fixture(fn: (db: DatabaseConnection) => void): void {
  const db = new Sqlite(":memory:");
  try {
    db.exec(WALLET_CANDIDATE_TEST_SCHEMA);
    db.prepare("INSERT INTO orders(id,user_id,status) VALUES (1,7,'paid')").run();
    db.prepare("INSERT INTO payments(id,order_id,status) VALUES (1,1,'paid')").run();
    db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (11,1,?)").run("2026-11-01T00:00:00.000Z");
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
const quote: AuthoritativeQuote = { key: "server-snapshot-1", serviceId: 11, ownerId: 7,
  priceFen: 900, durationId: "authoritative-month", period: "MONTHLY",
  previousEndsAt: service.endsAt!, newEndsAt: "2026-12-01T00:00:00.000Z" };
function topup(db: DatabaseConnection, orderRef = "t-1", amountFen = 1000): void {
  db.prepare("INSERT INTO wallet_topups(user_id,order_ref,amount_fen,currency) VALUES (7,?,?,'CNY')").run(orderRef, amountFen);
}
function credit(db: DatabaseConnection, orderRef = "t-1", trade = "trade-1", amountFen = 1000) {
  return creditVerifiedTopup(db, "merchant-1", { orderRef, providerTradeNo: trade, merchantId: "merchant-1",
    amountFen, currency: "CNY", finalStatus: "SUCCESS", signatureVerified: true }, AT);
}
function consent(db: DatabaseConnection): number { return setRenewalConsent(db, service, 7, "MONTHLY", quote, 0, true, AT); }

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

test("quote and owner are required; gift, missing end, missing quote and changed quote cannot debit", () => fixture((db) => {
  assert.throws(() => setRenewalConsent(db, { ...service, purchased: false }, 7, "MONTHLY", quote, 0, true, AT), /QUOTE_UNAVAILABLE/);
  assert.throws(() => setRenewalConsent(db, { ...service, endsAt: null }, 7, "MONTHLY", quote, 0, true, AT), /QUOTE_UNAVAILABLE/);
  assert.throws(() => setRenewalConsent(db, service, 8, "MONTHLY", quote, 0, true, AT), /FORBIDDEN/);
  assert.throws(() => setRenewalConsent(db, service, 7, "MONTHLY", null, 0, true, AT), /QUOTE_UNAVAILABLE/);
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
  assert.throws(() => setRenewalConsent(db, service, 7, "MONTHLY", quote, 0, false, AT), /REVISION_CONFLICT/);
}));

test("period change serializes with runner and forces renewed consent; disabling stays off", () => fixture((db) => {
  topup(db); credit(db); consent(db);
  assert.equal(changeNextBillingPeriod(db, 11, 7, "QUARTERLY", 1, AT), 2);
  assert.equal(state(db, 11), "RECONSENT_REQUIRED");
  assert.throws(() => runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), /REVISION_CONFLICT/);
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 2, AT), "RECONSENT_REQUIRED");
  assert.equal(walletBalance(db, 7), 1000);
  db.prepare("UPDATE services SET ends_at=NULL WHERE id=11").run();
  setRenewalConsent(db, { ...service, endsAt: null }, 7, "MONTHLY", null, 2, false, AT);
  changeNextBillingPeriod(db, 11, 7, "ANNUAL", 3, AT);
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

test("refund case separates actual stop from policy; wallet reversal is bounded and idempotent", () => fixture((db) => {
  topup(db); credit(db); consent(db); runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT);
  const admin = { userId: 99, sessionValid: true, csrfValid: true, isAdmin: true };
  assert.throws(() => requestPaidServiceTermination(db, { ...admin, isAdmin: false }, 11, "WALLET_RENEWAL", 1, AT), /FORBIDDEN/);
  assert.throws(() => requestPaidServiceTermination(db, admin, 11, "ORIGINAL_PAYMENT", 999, AT), /SOURCE_UNAVAILABLE/);
  requestPaidServiceTermination(db, admin, 11, "WALLET_RENEWAL", 1, AT);
  assert.equal(state(db, 11), "DISABLED");
  const termination = db.prepare(`SELECT t.stop_state,r.refund_state,r.source_kind FROM wallet_termination_cases t
    JOIN wallet_refund_cases r ON r.service_id=t.service_id WHERE t.service_id=11`).all()[0];
  assert.deepEqual(termination, { stop_state: "REQUESTED", refund_state: "AWAITING_POLICY", source_kind: "WALLET_RENEWAL" });
  assert.throws(() => recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 900, AT), /REFUND_NOT_PROCESSING/);
  db.prepare("UPDATE wallet_refund_cases SET refund_state='PROCESSING' WHERE service_id=11").run(); // isolated approved-policy fixture only
  assert.throws(() => recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 0, AT), /POLICY_REQUIRED/);
  assert.equal(recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 900, AT), "RECORDED");
  assert.equal(recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-1", 500, 900, AT), "REPLAY");
  assert.throws(() => recordWalletReversalFixture(db, "TEST_ONLY", admin, 1, "r-2", 500, 900, AT), /REFUND_EXCEEDS_PAID/);
  assert.equal(walletBalance(db, 7), 600);
  assert.equal(count(db, "wallet_refund_reversals"), 1);
}));
