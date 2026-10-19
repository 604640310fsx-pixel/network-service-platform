import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseConnection } from "../../src/db.js";
import type { TokenHmacKeyring } from "../../src/session/session-token.js";
import { WALLET_CANDIDATE_TEST_SCHEMA } from "../../src/wallet/schema.js";
import {
  creditVerifiedTopup, produceRenewalQuote, setRenewalConsent,
  type AuthoritativeQuote, type ServiceEligibility,
} from "../../src/wallet/candidate.js";
import {
  authorizeRenewalDispatch, recordRenewalEvidence, reserveRenewalOperation,
  type SimulatedExtensionEvidence,
} from "../../src/wallet/renewal-operations.js";
import { reconcileOwnerAlerts } from "../../src/alerts/owner-alert-events.js";
import {
  claimOwnerAlert, decryptOwnerAlertPayload, finalizeOwnerAlert,
  recordOwnerAlertDelivery,
} from "../../src/alerts/owner-alert-outbox.js";
import {
  createOwnerAlertPolicy, defaultOwnerAlertConfig, readOwnerAlertCases,
  OWNER_ALERT_RETRY_DELAYS_MS, type OwnerAlertConfig,
} from "../../src/alerts/owner-alert-runtime.js";
import { dispatchNextOwnerAlert } from "../../src/alerts/owner-alert-dispatcher.js";
import { SyntheticOwnerAlertTransport } from "../../src/alerts/owner-alert-transport.js";

const require = createRequire(import.meta.url);
const Sqlite = require("better-sqlite3") as new (path: string) => DatabaseConnection;

const AT = "2026-10-04T00:00:00.000Z";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DUE = new Date(Date.parse(AT) + 24 * HOUR + 1000).toISOString();

const KEYRING: TokenHmacKeyring = {
  version: 1, keys: { "1": Buffer.alloc(32, 9).toString("base64") },
};
const OWNER = "owner@example.invalid";

const cfg = (overrides: Partial<OwnerAlertConfig> = {}): OwnerAlertConfig =>
  defaultOwnerAlertConfig(OWNER, { leaseMs: 60 * 1000, ...overrides });

function seed(db: DatabaseConnection): void {
  db.exec(WALLET_CANDIDATE_TEST_SCHEMA);
  db.prepare(`INSERT INTO orders(id,user_id,status,type_id,region_id,isp_id,spec_id,duration_id,catalog_version)
    VALUES (1,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1')`).run();
  db.prepare("INSERT INTO payments(id,order_id,status) VALUES (1,1,'paid')").run();
  db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (11,1,?)")
    .run("2026-11-01T00:00:00.000Z");
  db.prepare(`INSERT INTO sellable_plans(id,type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,created_at,updated_at)
    VALUES (1,'local-isp','us','us-verizon',NULL,'month-1',900,1,?,?)`).run(AT, AT);
}
async function asyncFixture(fn: (db: DatabaseConnection) => Promise<void>): Promise<void> {
  const db = new Sqlite(":memory:");
  try {
    seed(db);
    await fn(db);
  } finally { db.close(); }
}
function count(db: DatabaseConnection, table: string, where = "1=1", ...args: unknown[]): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).all(...args)[0] as { n: number }).n;
}
function outboxRow(db: DatabaseConnection) {
  return db.prepare("SELECT * FROM owner_alert_outbox").all()[0] as Record<string, unknown> | undefined;
}

const service: ServiceEligibility = {
  serviceId: 11, ownerId: 7, purchased: true, endsAt: "2026-11-01T00:00:00.000Z",
};
const quote: AuthoritativeQuote = {
  key: "renewal-quote:SUBSCRIBE-CATALOG-V1:local-isp:us:us-verizon::month-1:900",
  serviceId: 11, ownerId: 7, priceFen: 900, durationId: "month-1", period: "MONTHLY",
  previousEndsAt: service.endsAt!, newEndsAt: "2026-12-01T00:00:00.000Z",
};
const evidence = (overrides: Partial<SimulatedExtensionEvidence> = {}): SimulatedExtensionEvidence => ({
  dispatchId: "disp-1", resourceKey: "service:11", outcome: "APPLIED",
  termEndsAt: "2026-12-01T00:00:00.000Z", sourceRef: "sim-provider-txn:1", ...overrides,
});
function topup(db: DatabaseConnection, orderRef: string, amountFen: number): void {
  db.prepare("INSERT INTO wallet_topups(user_id,order_ref,amount_fen,currency) VALUES (7,?,?,'CNY')").run(orderRef, amountFen);
  creditVerifiedTopup(db, "merchant-1", {
    orderRef, providerTradeNo: `trade-${orderRef}`, merchantId: "merchant-1",
    amountFen, currency: "CNY", finalStatus: "SUCCESS", signatureVerified: true,
  }, AT);
}
function dispatchedOp(db: DatabaseConnection): number {
  topup(db, "t-1", 1000);
  setRenewalConsent(
    db, 11, 7, "MONTHLY", 0, true, produceRenewalQuote(db, 11, "MONTHLY", 7).key, AT,
  );
  const result = reserveRenewalOperation(db, "TEST_ONLY", service, quote, 1, AT);
  if (typeof result !== "object" || result === null) throw new Error(`reserve failed: ${result}`);
  assert.equal(authorizeRenewalDispatch(db, "TEST_ONLY", result.operationId, "disp-1", AT), "AUTHORIZED");
  return result.operationId;
}

test("accepted send finalizes exactly once: outbox cleared, audit 'sent', first acceptance anchored", () => asyncFixture(async (db) => {
  dispatchedOp(db);
  const c = cfg();
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  const transport = new SyntheticOwnerAlertTransport();
  const policy = createOwnerAlertPolicy(c);
  assert.deepEqual(await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport, policy, config: c, now: () => DUE,
  }), { outcome: "sent", attempts: 1 });
  assert.equal(count(db, "owner_alert_outbox"), 0);
  const audit = db.prepare("SELECT * FROM owner_alert_audit").all()[0] as Record<string, unknown>;
  assert.equal(audit.outcome, "sent");
  assert.equal(audit.final_attempts, 1);
  assert.equal(audit.reminder_ordinal, 0);
  const event = db.prepare("SELECT first_notice_accepted_at FROM owner_alert_events").all()[0] as
    { first_notice_accepted_at: string };
  assert.equal(event.first_notice_accepted_at, DUE);
  const delivery = transport.calls[0];
  assert.equal(delivery?.reminderOrdinal, 0);
  assert.equal(delivery?.reason, "DISPATCH_UNKNOWN");
  assert.equal(delivery?.recipientRef, "HUMAN_OWNER");
  assert.equal(delivery?.recipient, OWNER);
  assert.match(delivery?.caseRef ?? "", /^renewal-op:\d+$/);
  // Nothing left to dispatch — the same event key stays idempotent.
  assert.deepEqual(await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport, policy, config: c, now: () => DUE,
  }), { outcome: "idle" });
  assert.equal(transport.calls.length, 1);
}));

test("exact 6-attempt budget on 5m/15m/1h/4h/8h gaps, then dead-letter stays visible", () => asyncFixture(async (db) => {
  dispatchedOp(db);
  const c = cfg();
  const policy = createOwnerAlertPolicy(c);
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  const transport = new SyntheticOwnerAlertTransport(new Array(6).fill("FAILED"));
  let now = DUE;
  const dispatch = () => dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport, policy, config: c, now: () => now,
  });
  assert.deepEqual(await dispatch(), { outcome: "retry_scheduled", attempts: 1 });
  for (const [index, gap] of OWNER_ALERT_RETRY_DELAYS_MS.entries()) {
    const row = outboxRow(db);
    assert.equal(row?.status, "pending");
    assert.equal(row?.attempts, index + 1);
    assert.equal(
      row?.next_attempt_at,
      new Date(Date.parse(now) + gap).toISOString(),
      `attempt ${index + 1} must wait exactly ${gap}ms`,
    );
    now = new Date(Date.parse(now) + gap).toISOString();
    // One tick early: still leased to its schedule.
    if (index < OWNER_ALERT_RETRY_DELAYS_MS.length - 1) {
      assert.deepEqual(await dispatchNextOwnerAlert({
        database: db, keyring: KEYRING, transport, policy, config: c,
        now: () => new Date(Date.parse(now) - 1).toISOString(),
      }), { outcome: "idle" });
    }
    const result = await dispatch();
    if (index < OWNER_ALERT_RETRY_DELAYS_MS.length - 1) {
      assert.deepEqual(result, { outcome: "retry_scheduled", attempts: index + 2 });
    } else {
      assert.deepEqual(result, { outcome: "dead_letter", attempts: 6 });
    }
  }
  assert.equal(count(db, "owner_alert_outbox"), 0);
  const audit = db.prepare(
    "SELECT * FROM owner_alert_audit WHERE outcome='dead_letter'",
  ).all()[0] as Record<string, unknown>;
  assert.equal(audit.detail, "transport_failed");
  assert.equal(audit.final_attempts, 6);
  const caseView = readOwnerAlertCases(db)[0];
  assert.equal(caseView?.deadLetters, 1);
  assert.equal(caseView?.unresolved, true); // exhaustion never hides the case
  assert.equal(caseView?.firstNoticeAcceptedAt, null);
}));

test("unknown results and thrown errors consume the same bounded budget — never counted as sent", () => asyncFixture(async (db) => {
  dispatchedOp(db);
  const c = cfg();
  const policy = createOwnerAlertPolicy(c);
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  const transport = new SyntheticOwnerAlertTransport(
    ["UNKNOWN", new Error("simulated socket drop"), "FAILED", "UNKNOWN", "FAILED", "UNKNOWN"],
  );
  let now = DUE;
  const outcomes: string[] = [];
  for (const gap of [0, ...OWNER_ALERT_RETRY_DELAYS_MS]) {
    now = new Date(Date.parse(now) + gap).toISOString();
    const result = await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport, policy, config: c, now: () => now,
    });
    if (result.outcome !== "idle") outcomes.push(result.outcome);
  }
  assert.deepEqual(outcomes, [
    "retry_scheduled", "retry_scheduled", "retry_scheduled",
    "retry_scheduled", "retry_scheduled", "dead_letter",
  ]);
  const audit = db.prepare(
    "SELECT detail FROM owner_alert_audit WHERE outcome='dead_letter'",
  ).all()[0] as { detail: string };
  assert.equal(audit.detail, "send_unknown"); // a thrown/unknown send is never 'sent'
  const event = db.prepare(
    "SELECT first_notice_accepted_at FROM owner_alert_events",
  ).all()[0] as { first_notice_accepted_at: string | null };
  assert.equal(event.first_notice_accepted_at, null);
}));

test("expired lease is reclaimable; concurrent claim and stale finalizer lose cleanly", () => {
  const path = join(tmpdir(), `owner-alert-claim-${process.pid}-${Date.now()}.db`);
  const dbA = new Sqlite(path);
  const dbB = new Sqlite(path);
  try {
    seed(dbA);
    dispatchedOp(dbA);
    const c = cfg({ leaseMs: 30 * 1000 });
    const policy = createOwnerAlertPolicy(c);
    reconcileOwnerAlerts(dbA, "TEST_ONLY", c, KEYRING, DUE);
    const claimedA = claimOwnerAlert(dbA, policy, c, KEYRING, DUE);
    assert.notEqual(claimedA, null);
    assert.equal(claimedA?.attempts, 1);
    // A live lease blocks the second claimant.
    assert.equal(claimOwnerAlert(dbB, policy, c, KEYRING, DUE), null);
    // After expiry the abandoned send is reclaimable — catch-up class (c).
    const afterLease = new Date(Date.parse(DUE) + 31 * 1000).toISOString();
    const claimedB = claimOwnerAlert(dbB, policy, c, KEYRING, afterLease);
    assert.notEqual(claimedB, null);
    assert.equal(claimedB?.attempts, 2); // the abandoned attempt still consumed budget
    // A's stale finalizer cannot overwrite B's lease.
    assert.equal(finalizeOwnerAlert(dbA, claimedA!, "sent", null, afterLease), false);
    assert.equal(finalizeOwnerAlert(dbB, claimedB!, "sent", null, afterLease), true);
    assert.equal(count(dbB, "owner_alert_audit", "outcome='sent' AND final_attempts=2"), 1);
  } finally {
    dbA.close();
    dbB.close();
    rmSync(path, { force: true });
  }
});

test("a notice whose case resolved after enqueue drops stale — no transport call, no attempt spent", () => asyncFixture(async (db) => {
  const op = dispatchedOp(db);
  const c = cfg();
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  // The dispatch result arrived between enqueue and claim — the case resolved.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), DUE), "RECORDED");
  const transport = new SyntheticOwnerAlertTransport();
  const result = await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport,
    policy: createOwnerAlertPolicy(c), config: c, now: () => DUE,
  });
  assert.deepEqual(result, { outcome: "stale", attempts: 0 });
  assert.equal(transport.calls.length, 0);
  const audit = db.prepare("SELECT * FROM owner_alert_audit").all()[0] as Record<string, unknown>;
  assert.equal(audit.outcome, "failed");
  assert.equal(audit.detail, "stale");
  assert.equal(audit.final_attempts, 0);
  assert.equal(count(db, "owner_alert_outbox"), 0);
}));

test("quarantined notices are never claimed", () => asyncFixture(async (db) => {
  dispatchedOp(db);
  const c = cfg();
  reconcileOwnerAlerts(db, "TEST_ONLY", cfg({ recipientConfigVersion: 1 }), KEYRING, DUE);
  db.prepare("UPDATE owner_alert_outbox SET status='quarantined'").run();
  const transport = new SyntheticOwnerAlertTransport();
  assert.deepEqual(await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport,
    policy: createOwnerAlertPolicy(c), config: c, now: () => DUE,
  }), { outcome: "idle" });
  assert.equal(transport.calls.length, 0);
}));

test("stored payload is encrypted and redacted; decryption round-trips the fixed field set", () => asyncFixture(async (db) => {
  const op = dispatchedOp(db);
  const c = cfg();
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  const row = outboxRow(db)!;
  for (const column of ["nonce", "ciphertext", "tag"]) {
    const blob = row[column] as Buffer;
    assert.ok(Buffer.isBuffer(blob));
    assert.equal(blob.toString("utf8").includes(OWNER), false);
    assert.equal(blob.toString("utf8").includes("renewal-op"), false);
    assert.equal(blob.toString("utf8").includes("disp-1"), false);
  }
  // No address is persisted anywhere in the row.
  assert.equal(JSON.stringify({ ...row, nonce: 0, ciphertext: 0, tag: 0 }).includes(OWNER), false);
  const payload = decryptOwnerAlertPayload({
    idempotencyKey: row.idempotency_key as string,
    eventKey: row.event_key as string,
    keyVersion: row.key_version as number,
    nonce: row.nonce as Buffer,
    ciphertext: row.ciphertext as Buffer,
    tag: row.tag as Buffer,
  }, KEYRING);
  // Payload is EXACTLY the redacted contract — episode/ordinal live only as
  // row metadata bound by the AAD idempotency key, never as payload keys.
  assert.deepEqual(payload, {
    case_ref: `renewal-op:${op}`,
    reason: "DISPATCH_UNKNOWN",
    anchor_at: AT,
    due_at: DUE,
  });
  assert.equal(row.episode, 0);
  assert.equal(row.reminder_ordinal, 0);
  // Tampered ciphertext/tag refuses.
  const tampered = Buffer.from(row.tag as Buffer);
  tampered[0] = tampered[0]! ^ 1;
  assert.throws(() => decryptOwnerAlertPayload({
    idempotencyKey: row.idempotency_key as string,
    eventKey: row.event_key as string,
    keyVersion: row.key_version as number,
    nonce: row.nonce as Buffer,
    ciphertext: row.ciphertext as Buffer,
    tag: tampered,
  }, KEYRING));
  // The audit trail binds the recipient by HMAC — never the address.
  const transport = new SyntheticOwnerAlertTransport();
  await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport,
    policy: createOwnerAlertPolicy(c), config: c, now: () => DUE,
  });
  const audit = db.prepare("SELECT recipient_hmac FROM owner_alert_audit").all()[0] as
    { recipient_hmac: string };
  assert.match(audit.recipient_hmac, /^v1\./);
  assert.equal(audit.recipient_hmac.includes(OWNER), false);
}));

test("delivery receipt: only after acceptance, replay-safe, distinct from accepted and ACK", () => asyncFixture(async (db) => {
  dispatchedOp(db);
  const c = cfg();
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  const key = outboxRow(db)!.idempotency_key as string;
  // Before acceptance there is nothing a delivery receipt can attach to.
  assert.throws(() => recordOwnerAlertDelivery(db, "TEST_ONLY", key, DUE), /INVALID_STATE/);
  const transport = new SyntheticOwnerAlertTransport();
  await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport,
    policy: createOwnerAlertPolicy(c), config: c, now: () => DUE,
  });
  assert.equal(recordOwnerAlertDelivery(db, "TEST_ONLY", key, DUE), "DELIVERED");
  const late = new Date(Date.parse(DUE) + 2 * HOUR).toISOString();
  assert.equal(recordOwnerAlertDelivery(db, "TEST_ONLY", key, late), "REPLAY");
  const caseView = readOwnerAlertCases(db)[0];
  assert.equal(caseView?.noticesAccepted, 1);
  assert.equal(caseView?.noticesDelivered, 1);
  assert.equal(caseView?.ownerAckAt, null); // delivered is not ACKed
}));

test("duplicate evidence replay does not shift anchors or spawn notices", () => asyncFixture(async (db) => {
  const op = dispatchedOp(db);
  const c = cfg();
  reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  const transport = new SyntheticOwnerAlertTransport();
  await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport,
    policy: createOwnerAlertPolicy(c), config: c, now: () => DUE,
  });
  const accepted = db.prepare("SELECT first_notice_accepted_at FROM owner_alert_events").all()[0] as
    { first_notice_accepted_at: string };
  // An identical replay of the same evidence is REPLAY — nothing moves.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), DUE), "RECORDED");
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), DUE), "REPLAY");
  assert.equal(count(db, "wallet_renewal_contradictions"), 0);
  const after = db.prepare("SELECT first_notice_accepted_at FROM owner_alert_events").all()[0] as
    { first_notice_accepted_at: string };
  assert.equal(after.first_notice_accepted_at, accepted.first_notice_accepted_at);
  const rerun = reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
  assert.equal(rerun.noticesEnqueued, 0);
}));

test("missing stored key_version pauses into quarantine: zero attempts, zero sends, survives restart", async () => {
  const path = join(tmpdir(), `owner-alert-key-${process.pid}-${Date.now()}.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    dispatchedOp(db);
    const c = cfg();
    const policy = createOwnerAlertPolicy(c);
    reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE); // notice encrypted under key_version 1
    assert.equal(outboxRow(db)?.key_version, 1);

    // A keyring that does not carry version 1 must pause, never burn budget.
    const KEYRING_MISSING: TokenHmacKeyring = {
      version: 2, keys: { "2": Buffer.alloc(32, 7).toString("base64") },
    };
    const transport = new SyntheticOwnerAlertTransport();
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING_MISSING, transport, policy, config: c, now: () => DUE,
    }), { outcome: "quarantined", attempts: 0 });
    assert.equal(transport.calls.length, 0); // no send, no recipient fallback
    const row = outboxRow(db);
    assert.equal(row?.status, "quarantined");
    assert.equal(row?.attempts, 0); // zero attempt budget consumed
    const audit = db.prepare("SELECT outcome,detail,final_attempts FROM owner_alert_audit").all() as
      { outcome: string; detail: string; final_attempts: number }[];
    assert.deepEqual(audit.map((a) => [a.outcome, a.detail, a.final_attempts]),
      [["quarantined", "key_unavailable", 0]]);

    db.close();
    db = new Sqlite(path);

    // Quarantine is durable and terminal: visible in the projection, never
    // claimed again — not under the wrong keyring, and not even after the
    // correct key returns. Explicit handling is required, no auto-recovery.
    const caseView = readOwnerAlertCases(db)[0];
    assert.equal(caseView?.unresolved, true);
    assert.equal(caseView?.noticesQuarantined, 1);
    for (const keyring of [KEYRING_MISSING, KEYRING]) {
      assert.deepEqual(await dispatchNextOwnerAlert({
        database: db, keyring, transport, policy, config: c, now: () => DUE,
      }), { outcome: "idle" });
    }
    assert.equal(transport.calls.length, 0);
    const rerun = reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
    assert.equal(rerun.noticesEnqueued, 0);
    assert.equal(rerun.remindersEnqueued, 0);
    assert.equal(outboxRow(db)?.status, "quarantined");
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test("expired final lease closes as dead_letter at attempts=6 — never a seventh send", async () => {
  const path = join(tmpdir(), `owner-alert-cap-${process.pid}-${Date.now()}.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    dispatchedOp(db);
    const c = cfg();
    const policy = createOwnerAlertPolicy(c);
    reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
    const transport = new SyntheticOwnerAlertTransport(new Array(6).fill("UNKNOWN"));

    // Five bounded failures then the sixth send is claimed and abandoned
    // mid-flight (crash): the row sits 'sending' with attempts=6.
    let now = DUE;
    for (const gap of [0, 5 * MIN, 15 * MIN, HOUR, 4 * HOUR]) {
      now = new Date(Date.parse(now) + gap).toISOString();
      await dispatchNextOwnerAlert({
        database: db, keyring: KEYRING, transport, policy, config: c, now: () => now,
      });
    }
    now = new Date(Date.parse(now) + 8 * HOUR).toISOString();
    const abandoned = claimOwnerAlert(db, policy, c, KEYRING, now);
    assert.equal(abandoned?.attempts, 6);
    assert.equal(outboxRow(db)?.status, "sending");

    db.close();
    db = new Sqlite(path);

    // After the lease expires the reclaim sees attempts already at the
    // ceiling: it dead-letters send_unknown WITHOUT a seventh transport call.
    const afterLease = new Date(Date.parse(now) + 61 * 1000).toISOString();
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport, policy, config: c, now: () => afterLease,
    }), { outcome: "dead_letter", attempts: 6 });
    assert.equal(transport.calls.length, 5); // five real sends, never a sixth re-send, never a seventh
    const audit = db.prepare("SELECT outcome,detail,final_attempts FROM owner_alert_audit").all() as
      { outcome: string; detail: string; final_attempts: number }[];
    assert.deepEqual(audit.map((a) => [a.outcome, a.detail, a.final_attempts]),
      [["dead_letter", "send_unknown", 6]]);
    assert.equal(count(db, "owner_alert_outbox"), 0);
    const view = readOwnerAlertCases(db)[0];
    assert.equal(view?.unresolved, true); // exhaustion stays visible, not hidden
    assert.equal(view?.deadLetters, 1);
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport, policy, config: c, now: () => afterLease,
    }), { outcome: "idle" });
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test("expired-lease 'sending' under drifted binding quarantines; stale finalizer loses; active lease untouched", async () => {
  const path = join(tmpdir(), `owner-alert-drift-${process.pid}-${Date.now()}.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    dispatchedOp(db);
    const c1 = cfg({ recipientConfigVersion: 1 });
    const c2 = cfg({ recipientConfigVersion: 2 });
    const policy1 = createOwnerAlertPolicy(c1);
    reconcileOwnerAlerts(db, "TEST_ONLY", c1, KEYRING, DUE);

    // Claim under v1: the row is 'sending' with a live lease.
    const claimed = claimOwnerAlert(db, policy1, c1, KEYRING, DUE);
    assert.equal(claimed?.attempts, 1);

    // Drift to v2 while the lease is ACTIVE — not parked, still owned.
    let rem = reconcileOwnerAlerts(db, "TEST_ONLY", c2, KEYRING, DUE);
    assert.equal(rem.quarantined, 0);
    assert.equal(outboxRow(db)?.status, "sending");

    // After the lease expires the same reconcile quarantines it visibly.
    const afterLease = new Date(Date.parse(DUE) + 61 * 1000).toISOString();
    rem = reconcileOwnerAlerts(db, "TEST_ONLY", c2, KEYRING, afterLease);
    assert.equal(rem.quarantined, 1);
    const row = outboxRow(db);
    assert.equal(row?.status, "quarantined");
    assert.equal(row?.lease_token, null);
    assert.equal(row?.recipient_config_version, 1); // binding history preserved
    assert.equal(row?.attempts, 1);
    assert.equal(count(db, "owner_alert_audit", "outcome='quarantined'"), 1);

    // The abandoned claim's finalizer loses — it owns a dead lease.
    assert.equal(finalizeOwnerAlert(db, claimed!, "sent", null, afterLease), false);

    // No send, no retarget under the new config — before and after restart.
    const transport = new SyntheticOwnerAlertTransport();
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport,
      policy: createOwnerAlertPolicy(c2), config: c2, now: () => afterLease,
    }), { outcome: "idle" });
    assert.equal(transport.calls.length, 0);

    db.close();
    db = new Sqlite(path);

    const view = readOwnerAlertCases(db)[0];
    assert.equal(view?.unresolved, true);
    assert.equal(view?.noticesQuarantined, 1);
    assert.equal(outboxRow(db)?.status, "quarantined");
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport,
      policy: createOwnerAlertPolicy(c2), config: c2, now: () => afterLease,
    }), { outcome: "idle" });
    assert.equal(transport.calls.length, 0);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
