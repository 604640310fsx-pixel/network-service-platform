import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseConnection } from "../../src/db.js";
import { WALLET_CANDIDATE_TEST_SCHEMA } from "../../src/wallet/schema.js";
import {
  creditVerifiedTopup, produceRenewalQuote, runRenewalFixture, setRenewalConsent, walletBalance,
  type AuthoritativeQuote, type ServiceEligibility,
} from "../../src/wallet/candidate.js";
import {
  authorizeRenewalDispatch, cancelRenewalOperation, evaluateRenewalEscalations, readRenewalOperation,
  recordRenewalEvidence, releaseRenewalOperation, reserveRenewalOperation, settleRenewalOperation,
  type SimulatedExtensionEvidence,
} from "../../src/wallet/renewal-operations.js";

const require = createRequire(import.meta.url);
const Sqlite = require("better-sqlite3") as new (path: string) => DatabaseConnection;
const AT = "2026-10-04T00:00:00.000Z";
function seed(db: DatabaseConnection): void {
  db.exec(WALLET_CANDIDATE_TEST_SCHEMA);
  db.prepare(`INSERT INTO orders(id,user_id,status,type_id,region_id,isp_id,spec_id,duration_id,catalog_version)
    VALUES (1,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1'),
           (2,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1')`).run();
  db.prepare("INSERT INTO payments(id,order_id,status) VALUES (1,1,'paid'),(2,2,'paid')").run();
  db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (11,1,?),(22,2,?)")
    .run("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
  db.prepare(`INSERT INTO sellable_plans(id,type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,created_at,updated_at)
    VALUES (1,'local-isp','us','us-verizon',NULL,'month-1',900,1,?,?),
           (2,'local-isp','us','us-verizon',NULL,'month-6',5000,1,?,?),
           (3,'local-isp','us','us-verizon',NULL,'month-12',9000,1,?,?)`).run(AT, AT, AT, AT, AT, AT);
}
function fixture(fn: (db: DatabaseConnection) => void): void {
  const db = new Sqlite(":memory:");
  try {
    seed(db);
    fn(db);
  } finally { db.close(); }
}
function count(db: DatabaseConnection, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).all()[0] as { n: number }).n;
}
function opRow(db: DatabaseConnection, id: number) {
  return db.prepare("SELECT * FROM wallet_renewal_operations WHERE id=?").all(id)[0] as Record<string, unknown>;
}
function holdRow(db: DatabaseConnection, operationId: number) {
  return db.prepare("SELECT * FROM wallet_renewal_holds WHERE operation_id=?").all(operationId)[0] as
    { state: string; amount_fen: number } | undefined;
}
function heldFen(db: DatabaseConnection, userId = 7): number {
  const row = db.prepare("SELECT COALESCE(SUM(amount_fen),0) AS held FROM wallet_renewal_holds WHERE user_id=? AND state='ACTIVE'")
    .all(userId)[0] as { held: number };
  return row.held;
}
const service: ServiceEligibility = { serviceId: 11, ownerId: 7, purchased: true, endsAt: "2026-11-01T00:00:00.000Z" };
const service2: ServiceEligibility = { serviceId: 22, ownerId: 7, purchased: true, endsAt: "2026-11-01T00:00:00.000Z" };
const quote: AuthoritativeQuote = { key: "renewal-quote:SUBSCRIBE-CATALOG-V1:local-isp:us:us-verizon::month-1:900",
  serviceId: 11, ownerId: 7, priceFen: 900, durationId: "month-1", period: "MONTHLY",
  previousEndsAt: service.endsAt!, newEndsAt: "2026-12-01T00:00:00.000Z" };
const quote2: AuthoritativeQuote = { ...quote, serviceId: 22 };
const evidence = (dispatchId = "disp-1", overrides: Partial<SimulatedExtensionEvidence> = {}): SimulatedExtensionEvidence => ({
  dispatchId, resourceKey: "service:11", outcome: "APPLIED",
  termEndsAt: "2026-12-01T00:00:00.000Z", sourceRef: "sim-provider-txn:1", ...overrides,
});
function topup(db: DatabaseConnection, orderRef: string, amountFen: number): void {
  db.prepare("INSERT INTO wallet_topups(user_id,order_ref,amount_fen,currency) VALUES (7,?,?,'CNY')").run(orderRef, amountFen);
  creditVerifiedTopup(db, "merchant-1", { orderRef, providerTradeNo: `trade-${orderRef}`, merchantId: "merchant-1",
    amountFen, currency: "CNY", finalStatus: "SUCCESS", signatureVerified: true }, AT);
}
function consent(db: DatabaseConnection, serviceId = 11): number {
  return setRenewalConsent(db, serviceId, 7, "MONTHLY", 0, true, produceRenewalQuote(db, serviceId, "MONTHLY", 7).key, AT);
}
function reserve(db: DatabaseConnection, expectedRevision = 1): number {
  const result = reserveRenewalOperation(db, "TEST_ONLY", service, quote, expectedRevision, AT);
  if (typeof result !== "object" || result === null) throw new Error(`reserve failed: ${result}`);
  return result.operationId;
}

test("hold reserves availability only; second same-period attempt duplicates; multiple holds accumulate", () => fixture((db) => {
  topup(db, "t-1", 1500);
  consent(db); consent(db, 22);
  const op1 = reserve(db);
  assert.equal(walletBalance(db, 7), 1500);
  assert.equal(heldFen(db), 900);
  // Duplicate attempt for the same service/prior period — new consent revision cannot bypass.
  assert.equal(reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
  // The existing negative-spend path honors B - H: 1500 - 900 = 600 < 900.
  assert.throws(() => runRenewalFixture(db, "TEST_ONLY", service2, quote2, 1, AT), /INSUFFICIENT_FUNDS/);
  assert.throws(() => reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT), /INSUFFICIENT_FUNDS/);
  topup(db, "t-2", 1200);
  const op2 = reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT);
  if (typeof op2 !== "object") throw new Error(`second reserve failed: ${op2}`);
  assert.ok(op2.operationId > op1);
  assert.equal(heldFen(db), 1800);
  assert.equal(walletBalance(db, 7), 2700); // holds never moved settled balance
  const view = readRenewalOperation(db, op1);
  assert.equal(view?.state, "HOLD_ACTIVE");
  assert.equal(view?.amountFen, 900);
  assert.equal(view?.quoteKey, quote.key);
  assert.equal(view?.consentRevision, 1);
  assert.equal(view?.newEndsAt, "2026-12-01T00:00:00.000Z");
}));

test("authorize dispatch once; replay is stable; a different dispatch identity is refused", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  assert.equal(authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT), "AUTHORIZED");
  assert.equal(readRenewalOperation(db, op)?.dispatchAnchorAt, AT);
  assert.equal(authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT), "REPLAY");
  assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-2", AT), /INVALID_STATE/);
  // Authorization is durable — after it the operation may not be cancelled or released.
  assert.throws(() => cancelRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  assert.throws(() => releaseRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
}));

test("cancellation wins only before dispatch authorization: hold released once, period freed", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", op, AT), "CANCELLED");
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", op, AT), "REPLAY");
  assert.equal(holdRow(db, op)?.state, "RELEASED");
  assert.equal(heldFen(db), 0);
  assert.equal(walletBalance(db, 7), 1000); // release never credits
  assert.equal(count(db, "wallet_ledger"), 1); // topup entry only — no ledger write for cancel
  assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT), /INVALID_STATE/);
  // A cancelled period attempt frees the slot for a fresh operation.
  const op2 = reserve(db);
  assert.notEqual(op2, op);
}));

test("reconsent inside reserve preserves the existing update+history+return semantics, no op/hold written", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  db.prepare("UPDATE sellable_plans SET price_fen=950 WHERE id=1").run();
  assert.equal(reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), "RECONSENT_REQUIRED");
  assert.equal(count(db, "wallet_renewal_operations"), 0);
  assert.equal(count(db, "wallet_renewal_holds"), 0);
  const consentRow = db.prepare("SELECT state,revision FROM wallet_consents WHERE service_id=11").all()[0] as
    { state: string; revision: number };
  assert.deepEqual(consentRow, { state: "RECONSENT_REQUIRED", revision: 2 });
  assert.equal(count(db, "wallet_consent_history"), 2);
  assert.throws(() => reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), /REVISION_CONFLICT/);
}));

test("post-dispatch consent disable and reprice settle the frozen snapshot only", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  // After T2, consent off and a reprice bind future cycles only — never this one.
  setRenewalConsent(db, 11, 7, "MONTHLY", 1, false, null, AT);
  db.prepare("UPDATE sellable_plans SET price_fen=9999 WHERE id=1").run();
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT), "RECORDED");
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "COMPLETED");
  const cycle = db.prepare("SELECT amount_fen,new_ends_at,quote_key FROM wallet_renewal_cycles WHERE service_id=11")
    .all()[0] as { amount_fen: number; new_ends_at: string; quote_key: string };
  assert.equal(cycle.amount_fen, 900); // consented snapshot, not the repriced 9999
  assert.equal(cycle.new_ends_at, "2026-12-01T00:00:00.000Z");
  assert.equal(walletBalance(db, 7), 100);
}));

test("committed-response loss replays cleanly: capture own hold once, one debit, one cycle", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT);
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "COMPLETED");
  assert.equal(walletBalance(db, 7), 100);
  assert.equal(holdRow(db, op)?.state, "CAPTURED");
  assert.equal(heldFen(db), 0);
  assert.equal(count(db, "wallet_renewal_cycles"), 1);
  const ledgerRows = db.prepare("SELECT kind,amount_fen,source_key FROM wallet_ledger ORDER BY id")
    .all() as Array<{ kind: string; amount_fen: number; source_key: string }>;
  assert.deepEqual(ledgerRows.map((r) => ({ kind: r.kind, amount_fen: r.amount_fen })), [
    { kind: "TOPUP", amount_fen: 1000 }, { kind: "RENEWAL_DEBIT", amount_fen: -900 },
  ]);
  // Committed response lost → caller replays the whole flow: each step is stable.
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "REPLAY");
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT), "REPLAY");
  assert.equal(authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT), "REPLAY");
  assert.equal(walletBalance(db, 7), 100);
  assert.equal(count(db, "wallet_renewal_cycles"), 1);
  assert.equal(count(db, "wallet_ledger"), 2);
  const ends = db.prepare("SELECT ends_at FROM services WHERE id=11").all()[0] as { ends_at: string };
  assert.equal(ends.ends_at, "2026-12-01T00:00:00.000Z");
}));

test("unknown after authorization: no release, no retry; 24h DUE marker is persistent and never resets", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  // Timeout is not definitive failure — release and settle both refuse.
  assert.throws(() => releaseRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  // Simulated restart: re-read persisted rows only — the anchor survives intact.
  const anchored = readRenewalOperation(db, op);
  assert.equal(anchored?.dispatchAnchorAt, AT);
  assert.equal(anchored?.escalationDueAt, null);
  const plus23h = new Date(Date.parse(AT) + 23 * 3600 * 1000).toISOString();
  const plus25h = new Date(Date.parse(AT) + 25 * 3600 * 1000).toISOString();
  const plus30h = new Date(Date.parse(AT) + 30 * 3600 * 1000).toISOString();
  assert.deepEqual(evaluateRenewalEscalations(db, "TEST_ONLY", plus23h), []);
  assert.deepEqual(evaluateRenewalEscalations(db, "TEST_ONLY", plus25h), [op]);
  assert.equal(readRenewalOperation(db, op)?.escalationDueAt, plus25h);
  // Re-evaluation and late activity never reset the marker or the anchor.
  assert.deepEqual(evaluateRenewalEscalations(db, "TEST_ONLY", plus30h), []);
  assert.equal(readRenewalOperation(db, op)?.dispatchAnchorAt, AT);
  assert.equal(readRenewalOperation(db, op)?.escalationDueAt, plus25h);
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(heldFen(db), 900); // hold is not auto-expired by the window
}));

test("external success survives a local settlement rollback; recovery is local-only", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT);
  db.exec(`CREATE TRIGGER fail_cycle BEFORE INSERT ON wallet_renewal_cycles
    BEGIN SELECT RAISE(ABORT,'cycle write failed'); END;`);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op, AT), /cycle write failed/);
  // The whole settlement rolled back — but external truth (evidence) stands.
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(heldFen(db), 900);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_ledger"), 1);
  assert.equal(readRenewalOperation(db, op)?.state, "EVIDENCE_RECORDED");
  assert.equal(count(db, "wallet_renewal_evidence"), 1);
  // Recovery replays the same local settlement only — never a second dispatch.
  db.exec("DROP TRIGGER fail_cycle");
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "COMPLETED");
  assert.equal(walletBalance(db, 7), 100);
  assert.equal(count(db, "wallet_renewal_cycles"), 1);
}));

test("evidence must bind dispatch, resource and term: forged, wrong-resource, wrong-term and unbound claims rejected", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  // No dispatch authorized yet — nothing may carry evidence at all.
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT), /INVALID_STATE/);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op, evidence("disp-forged"), AT), /EVIDENCE_MISMATCH/);
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op, evidence("disp-1", { resourceKey: "service:22" }), AT), /EVIDENCE_MISMATCH/);
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op,
    evidence("disp-1", { termEndsAt: "2027-01-01T00:00:00.000Z" }), AT), /EVIDENCE_MISMATCH/);
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op,
    evidence("disp-1", { outcome: "NO_EFFECT", termEndsAt: "2026-12-01T00:00:00.000Z" }), AT), /EVIDENCE_MISMATCH/);
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op, evidence("disp-1", { sourceRef: "" }), AT), /EVIDENCE_MISMATCH/);
  assert.equal(count(db, "wallet_renewal_evidence"), 0);
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT), "RECORDED");
  // A bound but contradictory late outcome is preserved append-only, not merged.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence("disp-1", { outcome: "REJECTED", termEndsAt: null }), AT), "CONFLICT");
  assert.equal(readRenewalOperation(db, op)?.state, "CONFLICT");
  assert.equal(count(db, "wallet_renewal_evidence"), 1); // original fact is kept
  assert.equal(count(db, "wallet_renewal_contradictions"), 1); // claim fact persisted
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  // A further distinct contradictory claim is also persisted, not silently lost.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op,
    evidence("disp-1", { outcome: "REJECTED", termEndsAt: null, sourceRef: "sim-provider-txn:2" }), AT), "CONFLICT");
  assert.equal(count(db, "wallet_renewal_contradictions"), 2);
  // An unresolved CONFLICT still blocks a fresh operation for the same period.
  assert.equal(reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
}));

test("contradictory late evidence after COMPLETED preserves the settled fact and logs the claim", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT);
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "COMPLETED");
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op,
    evidence("disp-1", { outcome: "REJECTED", termEndsAt: null }), AT), "CONFLICT");
  // The terminal row is never resurrected into the live-uniqueness set: state
  // stays COMPLETED while the contradiction is appended and marked on the row.
  assert.equal(readRenewalOperation(db, op)?.state, "COMPLETED");
  assert.ok(readRenewalOperation(db, op)?.conflictDetail?.includes("on:COMPLETED"));
  assert.equal(count(db, "wallet_renewal_contradictions"), 1);
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "REPLAY");
  // Nothing reverses itself: balance, cycle and ledger stand for owner reconciliation.
  assert.equal(walletBalance(db, 7), 100);
  assert.equal(count(db, "wallet_renewal_cycles"), 1);
  assert.equal(count(db, "wallet_ledger"), 2);
}));

test("post-dispatch local conflicts keep external success unresolved: closure, expiry drift, prior cycle", () => fixture((db) => {
  topup(db, "t-1", 3000); consent(db); consent(db, 22);
  const closed = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", closed, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", closed, evidence("disp-1"), AT);
  // Management closure between external success and settlement → unresolved CONFLICT.
  db.prepare("INSERT INTO wallet_order_closures(order_id,closed_by_user_id,closed_at) VALUES (1,2,?)").run(AT);
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", closed, AT), "CONFLICT");
  assert.equal(heldFen(db), 900);
  assert.equal(walletBalance(db, 7), 3000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_ledger"), 1);
  // Expiry moved by an outside path between evidence and settlement → CONFLICT.
  const drifted = reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT);
  const op2 = (drifted as { operationId: number }).operationId;
  authorizeRenewalDispatch(db, "TEST_ONLY", op2, "disp-2", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op2, evidence("disp-2", { resourceKey: "service:22" }), AT);
  db.prepare("UPDATE services SET ends_at='2026-11-15T00:00:00.000Z' WHERE id=22").run();
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op2, AT), "CONFLICT");
  assert.ok(String(readRenewalOperation(db, op2)?.conflictDetail).includes("expiry moved"));
  // Another path consumed the period between evidence and settlement → CONFLICT,
  // never an overwrite or second charge for that prior expiry.
  db.prepare(`INSERT INTO orders(id,user_id,status,type_id,region_id,isp_id,spec_id,duration_id,catalog_version)
    VALUES (3,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1')`).run();
  db.prepare("INSERT INTO payments(id,order_id,status) VALUES (3,3,'paid')").run();
  db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (33,3,'2026-11-01T00:00:00.000Z')").run();
  consent(db, 33);
  const op3 = reserveRenewalOperation(db, "TEST_ONLY", { ...service, serviceId: 33 }, { ...quote, serviceId: 33 }, 1, AT);
  if (typeof op3 !== "object") throw new Error(`third reserve failed: ${op3}`);
  authorizeRenewalDispatch(db, "TEST_ONLY", op3.operationId, "disp-3", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op3.operationId, evidence("disp-3", { resourceKey: "service:33" }), AT);
  db.prepare(`INSERT INTO wallet_renewal_cycles(service_id,previous_ends_at,new_ends_at,user_id,amount_fen,quote_key,created_at)
    VALUES (33,'2026-11-01T00:00:00.000Z','2026-12-01T00:00:00.000Z',7,900,'other-path',?)`).run(AT);
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op3.operationId, AT), "CONFLICT");
  assert.ok(String(readRenewalOperation(db, op3.operationId)?.conflictDetail).includes("already settled"));
  // Cycle count stays exactly the foreign one; no capture happened anywhere.
  assert.equal(count(db, "wallet_renewal_cycles"), 1);
  assert.equal(walletBalance(db, 7), 3000);
  assert.equal(heldFen(db), 2700);
}));

test("definitive no-effect releases the hold exactly once; late success preserves facts without resurrecting", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op,
    evidence("disp-1", { outcome: "NO_EFFECT", termEndsAt: null }), AT), "RECORDED");
  assert.equal(releaseRenewalOperation(db, "TEST_ONLY", op, AT), "RELEASED");
  assert.equal(releaseRenewalOperation(db, "TEST_ONLY", op, AT), "REPLAY");
  assert.equal(holdRow(db, op)?.state, "RELEASED");
  assert.equal(walletBalance(db, 7), 1000); // release is never a refund credit
  assert.equal(count(db, "wallet_ledger"), 1);
  assert.equal(heldFen(db), 0);
  // Late external success on a released operation: the claim is preserved
  // append-only, the row keeps its terminal RELEASED state, nothing resurrects.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT), "CONFLICT");
  assert.equal(readRenewalOperation(db, op)?.state, "RELEASED");
  assert.ok(readRenewalOperation(db, op)?.conflictDetail?.includes("on:RELEASED"));
  assert.equal(count(db, "wallet_renewal_contradictions"), 1);
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  // While that contradiction is unresolved, this period refuses a fresh attempt
  // and the legacy fixture runner alike.
  assert.throws(() => reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), /UNRESOLVED_CONFLICT/);
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
}));

test("non-test mode is rejected at every boundary; missing and malformed inputs fail closed", () => fixture((db) => {
  topup(db, "t-1", 1000); consent(db);
  assert.throws(() => reserveRenewalOperation(db, "PRODUCTION" as "TEST_ONLY", service, quote, 1, AT), /EXECUTION_DISABLED/);
  const op = reserve(db);
  for (const call of [
    () => authorizeRenewalDispatch(db, "PRODUCTION" as "TEST_ONLY", op, "disp-1", AT),
    () => cancelRenewalOperation(db, "PRODUCTION" as "TEST_ONLY", op, AT),
    () => recordRenewalEvidence(db, "PRODUCTION" as "TEST_ONLY", op, evidence(), AT),
    () => settleRenewalOperation(db, "PRODUCTION" as "TEST_ONLY", op, AT),
    () => releaseRenewalOperation(db, "PRODUCTION" as "TEST_ONLY", op, AT),
    () => evaluateRenewalEscalations(db, "PRODUCTION" as "TEST_ONLY", AT),
  ]) assert.throws(call, /EXECUTION_DISABLED/);
  assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", 999, "disp-1", AT), /NOT_FOUND/);
  assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", op, "", AT), /INVALID_REQUEST/);
  assert.throws(() => cancelRenewalOperation(db, "TEST_ONLY", 999, AT), /NOT_FOUND/);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", 999, AT), /NOT_FOUND/);
}));

test("T2 refuses any drift since reserve: closure, expiry, reprice, consent off/revision — no dispatch bound", () => fixture((db) => {
  topup(db, "t-1", 5000); consent(db);
  const refused: number[] = [];
  const refuse = (op: number, pattern: RegExp): void => {
    refused.push(op);
    assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-x", AT), pattern);
    // Refusal is side-effect free: no dispatch bound, hold still reserved.
    assert.equal(readRenewalOperation(db, op)?.dispatchId, null);
    assert.equal(readRenewalOperation(db, op)?.state, "HOLD_ACTIVE");
    assert.equal(holdRow(db, op)?.state, "ACTIVE");
  };
  // Reprice between T1 and T2 → quote drift refuses before a dispatch id exists.
  const priced = reserve(db);
  db.prepare("UPDATE sellable_plans SET price_fen=901 WHERE id=1").run();
  refuse(priced, /QUOTE_CHANGED/);
  db.prepare("UPDATE sellable_plans SET price_fen=900 WHERE id=1").run();
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", priced, AT), "CANCELLED");
  // Consent disabled after reserve → refuse (state), then after re-enable the
  // bound revision no longer matches → refuse (revision).
  const consentOff = reserve(db);
  setRenewalConsent(db, 11, 7, "MONTHLY", 1, false, null, AT);
  refuse(consentOff, /INVALID_STATE/);
  setRenewalConsent(db, 11, 7, "MONTHLY", 2, true, produceRenewalQuote(db, 11, "MONTHLY", 7).key, AT);
  assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", consentOff, "disp-x", AT), /REVISION_CONFLICT/);
  // A refused op stays cancellable pre-dispatch — the funds are freed, period released.
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", consentOff, AT), "CANCELLED");
  assert.equal(heldFen(db), 0);
  // Service expiry moved before dispatch → the snapshot no longer describes it.
  const drifted = reserve(db, 3);
  db.prepare("UPDATE services SET ends_at='2026-11-15T00:00:00.000Z' WHERE id=11").run();
  refuse(drifted, /QUOTE_CHANGED/);
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", drifted, AT), "CANCELLED");
  db.prepare("UPDATE services SET ends_at='2026-11-01T00:00:00.000Z' WHERE id=11").run();
  // Management closure between T1 and T2 → refused outright.
  const closed = reserve(db, 3);
  db.prepare("INSERT INTO wallet_order_closures(order_id,closed_by_user_id,closed_at) VALUES (1,2,?)").run(AT);
  refuse(closed, /SERVICE_CLOSED/);
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", closed, AT), "CANCELLED");
  db.prepare("DELETE FROM wallet_order_closures WHERE order_id=1").run();
  // Deactivated plan pre-dispatch → unavailable quote refuses.
  const noPlan = reserve(db, 3);
  db.prepare("UPDATE sellable_plans SET is_active=0 WHERE id=1").run();
  refuse(noPlan, /QUOTE_UNAVAILABLE/);
  db.prepare("UPDATE sellable_plans SET is_active=1 WHERE id=1").run();
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", noPlan, AT), "CANCELLED");
  // Nothing ever dispatched or debited.
  assert.equal(count(db, "wallet_renewal_evidence"), 0);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_ledger"), 1);
  assert.equal(walletBalance(db, 7), 5000);
  assert.equal(heldFen(db), 0);
  // A fresh, fully consistent attempt authorizes normally after the cleanups.
  const op = reserve(db, 3);
  assert.equal(authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-ok", AT), "AUTHORIZED");
}));

test("non-canonical stored ends_at settles: semantic expiry check, raw-format conditional write", () => fixture((db) => {
  db.prepare("UPDATE services SET ends_at='2026-11-01T00:00:00Z' WHERE id=11").run();
  topup(db, "t-1", 2000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT);
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "COMPLETED");
  assert.equal(walletBalance(db, 7), 1100);
  const ends = db.prepare("SELECT ends_at FROM services WHERE id=11").all()[0] as { ends_at: string };
  assert.equal(ends.ends_at, "2026-12-01T00:00:00.000Z");
  assert.equal(heldFen(db), 0);
  // A genuinely moved expiry still refuses — the raw-format fix is not leniency.
  consent(db, 22);
  const op2 = reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT);
  if (typeof op2 !== "object") throw new Error(`reserve failed: ${op2}`);
  authorizeRenewalDispatch(db, "TEST_ONLY", op2.operationId, "disp-2", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op2.operationId, evidence("disp-2", { resourceKey: "service:22" }), AT);
  db.prepare("UPDATE services SET ends_at='2026-12-31T00:00:00Z' WHERE id=22").run();
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op2.operationId, AT), "CONFLICT");
}));

test("legacy fixture cannot bypass an unresolved modeled operation for the same period", () => fixture((db) => {
  topup(db, "t-1", 2000); consent(db);
  const op = reserve(db);
  // Unresolved HOLD_ACTIVE already blocks the old direct-debit path.
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  assert.equal(runRenewalFixture(db, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
  assert.equal(walletBalance(db, 7), 2000);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_service_extensions"), 0);
  assert.equal(count(db, "wallet_ledger"), 1);
}));

test("wrong-route calls refuse without poisoning state; the correct route still completes", () => fixture((db) => {
  topup(db, "t-1", 2000); consent(db); consent(db, 22);
  // settle on a definitive no-effect operation refuses; release still works after.
  const noEffect = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", noEffect, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", noEffect,
    evidence("disp-1", { outcome: "NO_EFFECT", termEndsAt: null }), AT);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", noEffect, AT), /INVALID_STATE/);
  assert.equal(readRenewalOperation(db, noEffect)?.state, "EVIDENCE_RECORDED");
  assert.equal(releaseRenewalOperation(db, "TEST_ONLY", noEffect, AT), "RELEASED");
  // release on an APPLIED operation refuses; settlement still completes after.
  const applied = reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT);
  if (typeof applied !== "object") throw new Error(`reserve failed: ${applied}`);
  authorizeRenewalDispatch(db, "TEST_ONLY", applied.operationId, "disp-2", AT);
  recordRenewalEvidence(db, "TEST_ONLY", applied.operationId,
    evidence("disp-2", { resourceKey: "service:22" }), AT);
  assert.throws(() => releaseRenewalOperation(db, "TEST_ONLY", applied.operationId, AT), /INVALID_STATE/);
  assert.equal(readRenewalOperation(db, applied.operationId)?.state, "EVIDENCE_RECORDED");
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", applied.operationId, AT), "COMPLETED");
  assert.equal(count(db, "wallet_renewal_contradictions"), 0);
}));

test("synthetic external effect lives outside SQL: T3/T4 failures never need a second external action", () => fixture((db) => {
  /* Modeled provider boundary — plain JS state outside SQL. The dispatch call
     performs the simulated external effect once; a separate read-only query
     rebuilds evidence FROM provider state (never increments calls), so recovery
     consults external truth instead of replaying a retained response object. */
  const provider = {
    calls: 0,
    dispatched: new Map<string, { serviceId: number; termEndsAt: string }>(),
    applied: new Map<string, string>(),
  };
  const externalExtend = (dispatchId: string, serviceId: number, termEndsAt: string): void => {
    provider.calls += 1;
    provider.dispatched.set(dispatchId, { serviceId, termEndsAt });
    provider.applied.set(`service:${serviceId}`, termEndsAt);
  };
  const queryProvider = (dispatchId: string): SimulatedExtensionEvidence => {
    const sent = provider.dispatched.get(dispatchId);
    if (!sent) throw new Error("unknown dispatch");
    const applied = provider.applied.get(`service:${sent.serviceId}`);
    if (applied !== sent.termEndsAt) throw new Error("not applied");
    return { dispatchId, resourceKey: `service:${sent.serviceId}`, outcome: "APPLIED",
      termEndsAt: applied, sourceRef: `sim-ext:${dispatchId}` };
  };
  topup(db, "t-1", 1000); consent(db);
  const op = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op, "disp-1", AT);
  // The external effect happens outside the local store; its result is not
  // retained locally — later evidence is rebuilt by querying provider state.
  externalExtend("disp-1", 11, "2026-12-01T00:00:00.000Z");
  assert.equal(provider.calls, 1);
  // Crash between the external effect and T3: nothing persisted — the operation
  // stays unknown (dispatch-authorized, anchor intact), not settleable.
  assert.equal(readRenewalOperation(db, op)?.state, "DISPATCH_AUTHORIZED");
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  // Injected T3 insert failure rolls back cleanly; state/anchor/hold preserved.
  db.exec(`CREATE TRIGGER fail_evidence BEFORE INSERT ON wallet_renewal_evidence
    BEGIN SELECT RAISE(ABORT,'evidence write failed'); END;`);
  assert.throws(() => recordRenewalEvidence(db, "TEST_ONLY", op, queryProvider("disp-1"), AT), /evidence write failed/);
  assert.equal(readRenewalOperation(db, op)?.state, "DISPATCH_AUTHORIZED");
  assert.equal(readRenewalOperation(db, op)?.dispatchAnchorAt, AT);
  assert.equal(count(db, "wallet_renewal_evidence"), 0);
  assert.throws(() => releaseRenewalOperation(db, "TEST_ONLY", op, AT), /INVALID_STATE/);
  // Recovery re-persists evidence rebuilt from provider state — calls stay 1.
  db.exec("DROP TRIGGER fail_evidence");
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, queryProvider("disp-1"), AT), "RECORDED");
  assert.equal(provider.calls, 1);
  // External success then survives a local T4 rollback — provider truth intact.
  db.exec(`CREATE TRIGGER fail_cycle BEFORE INSERT ON wallet_renewal_cycles
    BEGIN SELECT RAISE(ABORT,'cycle write failed'); END;`);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op, AT), /cycle write failed/);
  assert.equal(provider.applied.get("service:11"), "2026-12-01T00:00:00.000Z");
  assert.equal(provider.calls, 1);
  assert.equal(walletBalance(db, 7), 1000);
  assert.equal(readRenewalOperation(db, op)?.state, "EVIDENCE_RECORDED");
  // Local-only retry captures once — never a second external action.
  db.exec("DROP TRIGGER fail_cycle");
  assert.equal(settleRenewalOperation(db, "TEST_ONLY", op, AT), "COMPLETED");
  assert.equal(provider.calls, 1);
  assert.equal(walletBalance(db, 7), 100);
}));

test("released op + fresh attempt + late success claim: persisted append-only, period frozen, no SQL error", () => fixture((db) => {
  topup(db, "t-1", 4000); consent(db); consent(db, 22);
  const op1 = reserve(db);
  authorizeRenewalDispatch(db, "TEST_ONLY", op1, "disp-1", AT);
  recordRenewalEvidence(db, "TEST_ONLY", op1,
    evidence("disp-1", { outcome: "NO_EFFECT", termEndsAt: null }), AT);
  assert.equal(releaseRenewalOperation(db, "TEST_ONLY", op1, AT), "RELEASED");
  // The freed period admits a fresh operation.
  const op2r = reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT);
  if (typeof op2r !== "object") throw new Error(`reserve failed: ${op2r}`);
  const op2 = op2r.operationId;
  // Late APPLIED claim against the released operation: no index violation, no
  // throw into the uniqueness set — the claim is appended and marked instead.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op1, evidence("disp-1"), AT), "CONFLICT");
  assert.equal(readRenewalOperation(db, op1)?.state, "RELEASED");
  assert.equal(count(db, "wallet_renewal_contradictions"), 1);
  // The fresh operation is frozen by the unresolved contradiction — authorize
  // and settle both refuse; its hold remains explicitly cancellable.
  assert.throws(() => authorizeRenewalDispatch(db, "TEST_ONLY", op2, "disp-2", AT), /UNRESOLVED_CONFLICT/);
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", op2, AT), /INVALID_STATE/);
  assert.equal(cancelRenewalOperation(db, "TEST_ONLY", op2, AT), "CANCELLED");
  // With the live slot freed by cancellation, a fresh reserve still reaches the
  // contradiction guard — the period stays frozen, not merely occupied.
  assert.throws(() => reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), /UNRESOLVED_CONFLICT/);
  // Settlement-side guard: on a second service/period an authorized, already
  // evidenced operation must refuse settlement when a late claim lands.
  const opA = reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT);
  if (typeof opA !== "object") throw new Error(`reserve failed: ${opA}`);
  authorizeRenewalDispatch(db, "TEST_ONLY", opA.operationId, "disp-a", AT);
  recordRenewalEvidence(db, "TEST_ONLY", opA.operationId,
    evidence("disp-a", { resourceKey: "service:22", outcome: "NO_EFFECT", termEndsAt: null }), AT);
  assert.equal(releaseRenewalOperation(db, "TEST_ONLY", opA.operationId, AT), "RELEASED");
  const opB = reserveRenewalOperation(db, "TEST_ONLY", service2, quote2, 1, AT);
  if (typeof opB !== "object") throw new Error(`reserve failed: ${opB}`);
  authorizeRenewalDispatch(db, "TEST_ONLY", opB.operationId, "disp-b", AT);
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", opB.operationId,
    evidence("disp-b", { resourceKey: "service:22" }), AT), "RECORDED");
  // Late APPLIED on the released opA — appended, terminal state kept.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", opA.operationId,
    evidence("disp-a", { resourceKey: "service:22" }), AT), "CONFLICT");
  assert.equal(readRenewalOperation(db, opA.operationId)?.state, "RELEASED");
  assert.throws(() => settleRenewalOperation(db, "TEST_ONLY", opB.operationId, AT), /UNRESOLVED_CONFLICT/);
  // Nothing moved: opB's own hold stays ACTIVE, balance/ledger/cycle unchanged.
  assert.equal(holdRow(db, opB.operationId)?.state, "ACTIVE");
  assert.equal(readRenewalOperation(db, opB.operationId)?.state, "EVIDENCE_RECORDED");
  assert.equal(walletBalance(db, 7), 4000);
  assert.equal(count(db, "wallet_ledger"), 1);
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  // A further distinct late claim is also persisted — never silently discarded.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op1,
    evidence("disp-1", { sourceRef: "sim-provider-txn:late-2" }), AT), "CONFLICT");
  assert.equal(count(db, "wallet_renewal_contradictions"), 3);
  // With TWO claims now on this (service, period), the guard still answers
  // UNRESOLVED_CONFLICT — not an INVARIANT from reading multiple rows.
  assert.throws(() => reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT), /UNRESOLVED_CONFLICT/);
}));

test("two connections, one file: serialized writers, shared invariants, cancel-vs-authorize first commit wins", () => {
  const path = join(tmpdir(), `nsp-renewal-ops-${process.pid}-${Date.now()}.db`);
  const a = new Sqlite(path);
  const b = new Sqlite(path);
  const isBusy = (err: unknown) => err instanceof Error &&
    (/SQLITE_BUSY|database is locked/i.test(err.message) ||
      (err as { code?: string }).code === "SQLITE_BUSY");
  try {
    seed(a);
    b.exec("PRAGMA busy_timeout=0");
    topup(a, "t-1", 1000);
    consent(a, 11);
    consent(b, 22);
    // While A holds an exclusive write transaction, B's own BEGIN and a real
    // reserve attempt both fail with actual SQLITE_BUSY — not just "an error".
    a.exec("BEGIN IMMEDIATE");
    assert.throws(() => b.exec("BEGIN IMMEDIATE"), isBusy);
    assert.throws(() => reserveRenewalOperation(b, "TEST_ONLY", service, quote, 1, AT), isBusy);
    a.exec("ROLLBACK");
    // Nothing partial leaked through the refused write; the retry succeeds.
    assert.equal(count(b, "wallet_renewal_operations"), 0);
    assert.equal(count(b, "wallet_renewal_holds"), 0);
    const r1 = reserveRenewalOperation(b, "TEST_ONLY", service, quote, 1, AT);
    if (typeof r1 !== "object") throw new Error(`reserve failed: ${r1}`);
    const op1 = r1.operationId;
    // Cross-connection visibility: A sees B's committed unresolved operation.
    assert.equal(reserveRenewalOperation(a, "TEST_ONLY", service, quote, 1, AT), "DUPLICATE");
    // Reserve-vs-reserve across connections on a DIFFERENT service/period:
    // B's committed hold (900 of 1000) leaves 100 spendable — A's 900 reserve
    // is refused, B >= H holds, and no additional hold row is created.
    assert.throws(() => reserveRenewalOperation(a, "TEST_ONLY", service2, quote2, 1, AT), /INSUFFICIENT_FUNDS/);
    assert.equal(walletBalance(a, 7), 1000);
    assert.equal(heldFen(a), 900);
    assert.equal(count(a, "wallet_renewal_holds"), 1);
    // The legacy debit path honors the same hold cross-connection.
    assert.throws(() => runRenewalFixture(b, "TEST_ONLY", service2, quote2, 1, AT), /INSUFFICIENT_FUNDS/);
    // Cancel on A vs authorize on B for the same op — whichever commits first wins.
    assert.equal(cancelRenewalOperation(a, "TEST_ONLY", op1, AT), "CANCELLED");
    assert.throws(() => authorizeRenewalDispatch(b, "TEST_ONLY", op1, "disp-a", AT), /INVALID_STATE/);
    // Opposite ordering: authorize on B first, then cancel on A is refused.
    const r2 = reserveRenewalOperation(a, "TEST_ONLY", service, quote, 1, AT);
    if (typeof r2 !== "object") throw new Error(`reserve failed: ${r2}`);
    assert.equal(authorizeRenewalDispatch(b, "TEST_ONLY", r2.operationId, "disp-b", AT), "AUTHORIZED");
    assert.throws(() => cancelRenewalOperation(a, "TEST_ONLY", r2.operationId, AT), /INVALID_STATE/);
    // Evidence on B, settlement on A, replay on B — one shared truth.
    assert.equal(recordRenewalEvidence(b, "TEST_ONLY", r2.operationId, evidence("disp-b"), AT), "RECORDED");
    assert.equal(settleRenewalOperation(a, "TEST_ONLY", r2.operationId, AT), "COMPLETED");
    assert.equal(settleRenewalOperation(b, "TEST_ONLY", r2.operationId, AT), "REPLAY");
    assert.equal(walletBalance(b, 7), 100);
    assert.equal(count(a, "wallet_renewal_cycles"), 1);
  } finally {
    a.close(); b.close();
    rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
  }
});

test("file-backed restart durability: anchor, hold, and DUE marker persist across close/reopen without reset", () => {
  /* A real close/reopen cycle on one task-local file — the earlier in-memory
     test could not prove durability because rows lived on the same connection.
     DUE is a persisted marker only; nothing here delivers a notification. */
  const path = join(tmpdir(), `nsp-renewal-dur-${process.pid}-${Date.now()}.db`);
  const plus25h = new Date(Date.parse(AT) + 25 * 3600 * 1000).toISOString();
  const plus30h = new Date(Date.parse(AT) + 30 * 3600 * 1000).toISOString();
  let opId = -1;
  try {
    const a = new Sqlite(path);
    try {
      seed(a);
      topup(a, "t-1", 1000);
      consent(a, 11);
      const r = reserveRenewalOperation(a, "TEST_ONLY", service, quote, 1, AT);
      if (typeof r !== "object") throw new Error(`reserve failed: ${r}`);
      opId = r.operationId;
      assert.equal(authorizeRenewalDispatch(a, "TEST_ONLY", opId, "disp-1", AT), "AUTHORIZED");
    } finally { a.close(); }
    // Fresh connection, same file — a simulated process restart.
    const c = new Sqlite(path);
    try {
      const reopened = readRenewalOperation(c, opId);
      assert.equal(reopened?.state, "DISPATCH_AUTHORIZED");
      assert.equal(reopened?.dispatchAnchorAt, AT);
      assert.equal(reopened?.escalationDueAt, null);
      assert.equal(walletBalance(c, 7), 1000);
      assert.equal(heldFen(c), 900);
      // Replaying the bound dispatch identity after restart: REPLAY — the
      // stored anchor is authoritative, never rewritten.
      assert.equal(authorizeRenewalDispatch(c, "TEST_ONLY", opId, "disp-1", AT), "REPLAY");
      assert.equal(readRenewalOperation(c, opId)?.dispatchAnchorAt, AT);
      assert.deepEqual(evaluateRenewalEscalations(c, "TEST_ONLY", plus25h), [opId]);
    } finally { c.close(); }
    // Reopen once more: marker and anchor survived; repeat checks never reset.
    const d = new Sqlite(path);
    try {
      const ro = readRenewalOperation(d, opId);
      assert.equal(ro?.dispatchAnchorAt, AT);
      assert.equal(ro?.escalationDueAt, plus25h);
      assert.deepEqual(evaluateRenewalEscalations(d, "TEST_ONLY", plus30h), []);
      assert.equal(authorizeRenewalDispatch(d, "TEST_ONLY", opId, "disp-1", AT), "REPLAY");
      // Anchor, marker, and state unchanged; no release/capture/redispatch.
      assert.equal(readRenewalOperation(d, opId)?.dispatchAnchorAt, AT);
      assert.equal(readRenewalOperation(d, opId)?.escalationDueAt, plus25h);
      assert.equal(readRenewalOperation(d, opId)?.state, "DISPATCH_AUTHORIZED");
      assert.equal(holdRow(d, opId)?.state, "ACTIVE");
      assert.equal(walletBalance(d, 7), 1000);
      assert.equal(count(d, "wallet_ledger"), 1);
      assert.equal(count(d, "wallet_renewal_cycles"), 0);
    } finally { d.close(); }
  } finally {
    rmSync(path, { force: true }); rmSync(`${path}-wal`, { force: true }); rmSync(`${path}-shm`, { force: true });
  }
});
