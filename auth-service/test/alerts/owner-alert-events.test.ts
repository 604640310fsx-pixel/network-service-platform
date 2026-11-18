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
  creditVerifiedTopup, produceRenewalQuote, setRenewalConsent, walletBalance,
  type AuthoritativeQuote, type ServiceEligibility,
} from "../../src/wallet/candidate.js";
import {
  authorizeRenewalDispatch, evaluateRenewalEscalations, readRenewalOperation,
  recordRenewalEvidence, reserveRenewalOperation, type SimulatedExtensionEvidence,
} from "../../src/wallet/renewal-operations.js";
import { reconcileOwnerAlerts } from "../../src/alerts/owner-alert-events.js";
import {
  recordOwnerAlertAck, recordOwnerAlertDelivery,
} from "../../src/alerts/owner-alert-outbox.js";
import {
  createOwnerAlertPolicy, defaultOwnerAlertConfig, readOwnerAlertCases,
  type OwnerAlertConfig,
} from "../../src/alerts/owner-alert-runtime.js";
import { dispatchNextOwnerAlert } from "../../src/alerts/owner-alert-dispatcher.js";
import { SyntheticOwnerAlertTransport } from "../../src/alerts/owner-alert-transport.js";

const require = createRequire(import.meta.url);
const Sqlite = require("better-sqlite3") as new (path: string) => DatabaseConnection;

const AT = "2026-10-04T00:00:00.000Z";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const plus = (ms: number): string => new Date(Date.parse(AT) + ms).toISOString();
const DUE = plus(24 * HOUR + 1000); // first instant the anchor is overdue

const KEYRING: TokenHmacKeyring = {
  version: 1, keys: { "1": Buffer.alloc(32, 9).toString("base64") },
};
const OWNER = "owner@example.invalid";

const cfg = (overrides: Partial<OwnerAlertConfig> = {}): OwnerAlertConfig =>
  defaultOwnerAlertConfig(OWNER, { leaseMs: 60 * 1000, ...overrides });

function seed(db: DatabaseConnection): void {
  db.exec(WALLET_CANDIDATE_TEST_SCHEMA);
  db.prepare(`INSERT INTO orders(id,user_id,status,type_id,region_id,isp_id,spec_id,duration_id,catalog_version)
    VALUES (1,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1'),
           (2,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1'),
           (3,7,'paid','local-isp','us','us-verizon',NULL,'month-1','CATV1')`).run();
  db.prepare("INSERT INTO payments(id,order_id,status) VALUES (1,1,'paid'),(2,2,'paid'),(3,3,'paid')").run();
  db.prepare("INSERT INTO services(id,payment_id,ends_at) VALUES (11,1,?),(22,2,?),(33,3,?)")
    .run("2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z", "2026-11-01T00:00:00.000Z");
  db.prepare(`INSERT INTO sellable_plans(id,type_id,region_id,isp_id,spec_id,duration_id,price_fen,is_active,created_at,updated_at)
    VALUES (1,'local-isp','us','us-verizon',NULL,'month-1',900,1,?,?)`).run(AT, AT);
}
function fixture(fn: (db: DatabaseConnection) => void): void {
  const db = new Sqlite(":memory:");
  try {
    seed(db);
    fn(db);
  } finally { db.close(); }
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

const service: ServiceEligibility = {
  serviceId: 11, ownerId: 7, purchased: true, endsAt: "2026-11-01T00:00:00.000Z",
};
const service2: ServiceEligibility = { ...service, serviceId: 22 };
const service3: ServiceEligibility = { ...service, serviceId: 33 };
const quote: AuthoritativeQuote = {
  key: "renewal-quote:SUBSCRIBE-CATALOG-V1:local-isp:us:us-verizon::month-1:900",
  serviceId: 11, ownerId: 7, priceFen: 900, durationId: "month-1", period: "MONTHLY",
  previousEndsAt: service.endsAt!, newEndsAt: "2026-12-01T00:00:00.000Z",
};
const quote2: AuthoritativeQuote = { ...quote, serviceId: 22 };
const quote3: AuthoritativeQuote = { ...quote, serviceId: 33 };
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
function consent(db: DatabaseConnection, serviceId = 11): number {
  return setRenewalConsent(
    db, serviceId, 7, "MONTHLY", 0, true,
    produceRenewalQuote(db, serviceId, "MONTHLY", 7).key, AT,
  );
}
/* A DISPATCH_AUTHORIZED operation anchored at AT — due once `now` passes AT+24h. */
function dispatchedOp(
  db: DatabaseConnection, svc = service, qt = quote, orderRef = "t-1", dispatchId = "disp-1",
): number {
  topup(db, orderRef, 1000);
  consent(db, svc.serviceId);
  const result = reserveRenewalOperation(db, "TEST_ONLY", svc, qt, 1, AT);
  if (typeof result !== "object" || result === null) throw new Error(`reserve failed: ${result}`);
  assert.equal(
    authorizeRenewalDispatch(db, "TEST_ONLY", result.operationId, dispatchId, AT),
    "AUTHORIZED",
  );
  return result.operationId;
}

test("overdue dispatch produces DUE mark + event + encrypted notice atomically; rerun is idempotent", () => fixture((db) => {
  const op = dispatchedOp(db);
  const first = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.deepEqual(first, {
    dueMarked: 1, eventsCreated: 1, noticesEnqueued: 1, remindersEnqueued: 0, quarantined: 0,
  });
  const view = readRenewalOperation(db, op);
  assert.equal(view?.state, "DISPATCH_AUTHORIZED");
  assert.equal(view?.escalationDueAt, DUE);
  assert.equal(view?.dispatchAnchorAt, AT); // earliest anchor preserved
  assert.equal(count(db, "owner_alert_events", "reason='DISPATCH_UNKNOWN' AND episode=0"), 1);
  assert.equal(count(db, "owner_alert_outbox", "status='pending' AND reminder_ordinal=0"), 1);
  // Durable DUE marker is not a delivery receipt — the notice waits pending.
  const cases = readOwnerAlertCases(db);
  assert.equal(cases.length, 1);
  assert.equal(cases[0]?.unresolved, true);
  assert.equal(cases[0]?.noticesInFlight, 1);
  assert.equal(cases[0]?.noticesAccepted, 0);
  const replay = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.deepEqual(replay, {
    dueMarked: 0, eventsCreated: 0, noticesEnqueued: 0, remindersEnqueued: 0, quarantined: 0,
  });
  assert.equal(count(db, "owner_alert_outbox"), 1);
}));

test("enqueue failure rolls back the DUE mark — no unmarked-orphan gap", () => fixture((db) => {
  const op = dispatchedOp(db);
  const brokenKeyring: TokenHmacKeyring = { version: 9, keys: { "1": KEYRING.keys["1"]! } };
  assert.throws(
    () => reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), brokenKeyring, DUE),
    /ALERT_KEY_INVALID/,
  );
  // Atomicity proof: no partial DUE marker, no event, no notice survived.
  assert.equal(readRenewalOperation(db, op)?.escalationDueAt, null);
  assert.equal(count(db, "owner_alert_events"), 0);
  assert.equal(count(db, "owner_alert_outbox"), 0);
  // The failure is fail-closed, not latching: a later pass with a valid
  // keyring still catches the same overdue operation up cleanly.
  const healed = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.equal(healed.dueMarked, 1);
  assert.equal(healed.noticesEnqueued, 1);
  assert.equal(count(db, "owner_alert_outbox", "status='pending'"), 1);
}));

test("catch-up repairs all three outage classes", () => fixture((db) => {
  const op1 = dispatchedOp(db);
  // Class (b): durable DUE without its outbox row — the plain evaluator's window.
  assert.deepEqual(evaluateRenewalEscalations(db, "TEST_ONLY", DUE), [op1]);
  assert.equal(count(db, "owner_alert_outbox"), 0);
  const repaired = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.equal(repaired.dueMarked, 0); // DUE already durable, not rewritten
  assert.equal(repaired.noticesEnqueued, 1);
  assert.equal(count(db, "owner_alert_outbox", "status='pending'"), 1);
  // Class (a): a second operation was already overdue while the evaluator was
  // down — it never received a DUE mark at all.
  const op2 = dispatchedOp(db, service2, quote2, "t-2", "disp-2");
  const second = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.equal(second.dueMarked, 1);
  assert.equal(second.noticesEnqueued, 1);
  assert.equal(readRenewalOperation(db, op2)?.escalationDueAt, DUE);
  assert.equal(count(db, "owner_alert_events"), 2);
  // Class (c): a claimed-but-unfinished notice (expired lease) stays claimable —
  // covered end-to-end by the dispatcher suite's lease-expiry case.
}));

test("canonical dedup: equivalent contradiction rows share one event; a new claim keeps a new episode", () => fixture((db) => {
  const op = dispatchedOp(db);
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence(), AT), "RECORDED");
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence({
    outcome: "REJECTED", termEndsAt: null, sourceRef: "sim-provider-txn:2",
  }), AT), "CONFLICT");
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence({
    outcome: "REJECTED", termEndsAt: null, sourceRef: "sim-provider-txn:3",
  }), AT), "CONFLICT"); // same meaning, new physical row
  assert.equal(count(db, "wallet_renewal_contradictions"), 2);
  const first = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.equal(first.eventsCreated, 1); // both equivalent rows → ONE event
  assert.equal(first.noticesEnqueued, 1);
  assert.equal(count(db, "owner_alert_events", "reason='CONTRADICTION' AND episode=0"), 1);
  // A genuinely different claim is a preserved new episode, never swallowed.
  assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence({
    outcome: "NO_EFFECT", termEndsAt: null, sourceRef: "sim-provider-txn:4",
  }), AT), "CONFLICT");
  const second = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  assert.equal(second.eventsCreated, 1);
  assert.equal(second.noticesEnqueued, 1);
  assert.equal(count(db, "owner_alert_events", "reason='CONTRADICTION' AND episode=1"), 1);
  assert.equal(count(db, "owner_alert_outbox", "status='pending'"), 2);
  const episodes = readOwnerAlertCases(db).filter((c) => c.reason === "CONTRADICTION");
  assert.equal(episodes.length, 2);
  assert.deepEqual(episodes.map((c) => c.episode).sort(), [0, 1]);
}));

test("recipient binding drift quarantines pending notices — visible, never auto-retargeted", () => asyncFixture(async (db) => {
  dispatchedOp(db);
  reconcileOwnerAlerts(db, "TEST_ONLY", cfg({ recipientConfigVersion: 1 }), KEYRING, DUE);
  const v2 = cfg({ recipientConfigVersion: 2 });
  const drifted = reconcileOwnerAlerts(db, "TEST_ONLY", v2, KEYRING, DUE);
  assert.equal(drifted.quarantined, 1);
  assert.equal(count(db, "owner_alert_outbox", "status='quarantined'"), 1);
  assert.equal(count(db, "owner_alert_audit", "outcome='quarantined'"), 1);
  const caseView = readOwnerAlertCases(db)[0];
  assert.equal(caseView?.noticesQuarantined, 1); // visible, not silently lost
  assert.equal(caseView?.unresolved, true);
  // The dispatcher never rebinds, never falls back, and never delivers it.
  const transport = new SyntheticOwnerAlertTransport();
  const v2Policy = createOwnerAlertPolicy(v2);
  assert.deepEqual(await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport, policy: v2Policy, config: v2, now: () => DUE,
  }), { outcome: "idle" });
  assert.equal(transport.calls.length, 0);
  // Repeated evaluator ticks keep it quarantined — no retarget path exists.
  const again = reconcileOwnerAlerts(db, "TEST_ONLY", v2, KEYRING, DUE);
  assert.equal(again.quarantined, 0);
  assert.equal(again.noticesEnqueued, 0);
  assert.equal(count(db, "owner_alert_outbox", "status='quarantined'"), 1);
  assert.deepEqual(await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport, policy: v2Policy, config: v2, now: () => DUE,
  }), { outcome: "idle" });
  assert.equal(transport.calls.length, 0);
  assert.equal(readOwnerAlertCases(db)[0]?.noticesQuarantined, 1);
}));

test("at most one +24h reminder while unresolved and un-ACKed; never without a first acceptance", async () => {
  await asyncFixture(async (db) => {
    dispatchedOp(db);
    const c = cfg();
    const policy = createOwnerAlertPolicy(c);
    reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
    let now = DUE;
    const transport = new SyntheticOwnerAlertTransport();
    const dispatch = () => dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport, policy, config: c, now: () => now,
    });
    assert.deepEqual(await dispatch(), { outcome: "sent", attempts: 1 });
    const acceptedAt = now;
    // Under the delay nothing; after +24h unresolved + no ACK → one reminder.
    now = new Date(Date.parse(acceptedAt) + 12 * HOUR).toISOString();
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, now).remindersEnqueued, 0);
    now = new Date(Date.parse(acceptedAt) + 24 * HOUR + 1000).toISOString();
    const reminded = reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, now);
    assert.equal(reminded.remindersEnqueued, 1);
    // A sent notice is never resurrected by later reconcile passes.
    assert.equal(reminded.noticesEnqueued, 0);
    assert.equal(count(db, "owner_alert_outbox", "status='pending' AND reminder_ordinal=1"), 1);
    // Re-running while the reminder is in flight spawns nothing more.
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, now).remindersEnqueued, 0);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(await dispatch(), { outcome: "sent", attempts: 1 }); // own bounded budget
    assert.equal(transport.calls[1]?.reminderOrdinal, 1);
    // The completed reminder consumes the single ordinal — no ordinal 2 ever.
    now = new Date(Date.parse(acceptedAt) + 72 * HOUR).toISOString();
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, now).remindersEnqueued, 0);
  });
  await asyncFixture(async (db) => {
    dispatchedOp(db);
    const c = cfg();
    reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
    // Never accepted (all attempts UNKNOWN) — failure path only, no reminder bypass.
    const transport = new SyntheticOwnerAlertTransport(new Array(6).fill("UNKNOWN"));
    let now = DUE;
    const policy = createOwnerAlertPolicy(c);
    for (const gap of [0, 5 * MIN, 15 * MIN, HOUR, 4 * HOUR, 8 * HOUR]) {
      now = new Date(Date.parse(now) + gap).toISOString();
      await dispatchNextOwnerAlert({
        database: db, keyring: KEYRING, transport, policy, config: c, now: () => now,
      });
    }
    assert.equal(count(db, "owner_alert_audit", "outcome='dead_letter'"), 1);
    const farLater = new Date(Date.parse(DUE) + 96 * HOUR).toISOString();
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, farLater).remindersEnqueued, 0);
    const caseView = readOwnerAlertCases(db)[0];
    assert.equal(caseView?.unresolved, true); // dead-letter stays visible, never silently lost
    assert.equal(caseView?.deadLetters, 1);
    assert.equal(caseView?.firstNoticeAcceptedAt, null);
  });
});

test("owner ACK binds role + recipient version + exact event; idempotent; not a business resolution", () => fixture((db) => {
  const op = dispatchedOp(db);
  reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  const event = db.prepare("SELECT event_key FROM owner_alert_events").all()[0] as { event_key: string };
  const ack = {
    eventKey: event.event_key, actorRole: "HUMAN_OWNER",
    recipientRef: "HUMAN_OWNER", recipientConfigVersion: 1,
  };
  assert.throws(
    () => recordOwnerAlertAck(db, "TEST_ONLY", { ...ack, actorRole: "CUSTOMER" }, DUE),
    /ACK_FORBIDDEN/,
  );
  assert.throws(
    () => recordOwnerAlertAck(db, "TEST_ONLY", { ...ack, recipientConfigVersion: 2 }, DUE),
    /ACK_FORBIDDEN/,
  );
  assert.throws(
    () => recordOwnerAlertAck(db, "TEST_ONLY", { ...ack, eventKey: "owner-alert-v1:DISPATCH_UNKNOWN:bad" }, DUE),
    /NOT_FOUND/,
  );
  assert.equal(recordOwnerAlertAck(db, "TEST_ONLY", ack, DUE), "ACKED");
  assert.equal(recordOwnerAlertAck(db, "TEST_ONLY", ack, DUE), "REPLAY");
  // ACK is handling acknowledgement only — the business case stays unresolved.
  const caseView = readOwnerAlertCases(db)[0];
  assert.equal(caseView?.unresolved, true);
  assert.equal(caseView?.ownerAckAt, DUE);
  assert.equal(readRenewalOperation(db, op)?.state, "DISPATCH_AUTHORIZED");
  // No reminder is enqueued after ACK.
  const later = new Date(Date.parse(DUE) + 48 * HOUR).toISOString();
  assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, later).remindersEnqueued, 0);
}));

test("anchors and notice survive close/reopen — restart-safe", () => {
  const path = join(tmpdir(), `owner-alert-${process.pid}-${Date.now()}.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    const op = dispatchedOp(db);
    reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
    db.close();
    db = new Sqlite(path);
    const view = readRenewalOperation(db, op);
    assert.equal(view?.dispatchAnchorAt, AT);
    assert.equal(view?.escalationDueAt, DUE);
    assert.equal(count(db, "owner_alert_outbox", "status='pending'"), 1);
    const replay = reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
    assert.deepEqual(replay, {
      dueMarked: 0, eventsCreated: 0, noticesEnqueued: 0, remindersEnqueued: 0, quarantined: 0,
    });
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test("notification bookkeeping moves zero supplier/funds/service effects", () => asyncFixture(async (db) => {
  const op = dispatchedOp(db);
  reconcileOwnerAlerts(db, "TEST_ONLY", cfg(), KEYRING, DUE);
  const transport = new SyntheticOwnerAlertTransport();
  const c = cfg();
  assert.deepEqual(await dispatchNextOwnerAlert({
    database: db, keyring: KEYRING, transport,
    policy: createOwnerAlertPolicy(c), config: c, now: () => DUE,
  }), { outcome: "sent", attempts: 1 });
  assert.equal(walletBalance(db, 7), 1000); // settled balance untouched
  const held = db.prepare(
    "SELECT COALESCE(SUM(amount_fen),0) AS h FROM wallet_renewal_holds WHERE user_id=7 AND state='ACTIVE'",
  ).all()[0] as { h: number };
  assert.equal(held.h, 900); // hold still held — never released by a notification
  assert.equal(count(db, "wallet_ledger"), 1); // topup entry only
  assert.equal(count(db, "wallet_renewal_cycles"), 0);
  assert.equal(count(db, "wallet_service_extensions"), 0);
  const ends = db.prepare("SELECT ends_at FROM services WHERE id=11").all()[0] as { ends_at: string };
  assert.equal(ends.ends_at, "2026-11-01T00:00:00.000Z"); // service expiry untouched
  assert.equal(readRenewalOperation(db, op)?.state, "DISPATCH_AUTHORIZED");
  assert.equal(count(db, "wallet_renewal_evidence"), 0); // no evidence synthesized
}));

test("TEST_ONLY gate on every alert entry point", () => fixture((db) => {
  dispatchedOp(db);
  const prod = "PRODUCTION" as unknown as "TEST_ONLY";
  assert.throws(() => reconcileOwnerAlerts(db, prod, cfg(), KEYRING, DUE), /EXECUTION_DISABLED/);
  assert.throws(
    () => recordOwnerAlertAck(db, prod, {
      eventKey: "x", actorRole: "HUMAN_OWNER", recipientRef: "HUMAN_OWNER", recipientConfigVersion: 1,
    }, DUE),
    /EXECUTION_DISABLED/,
  );
  assert.throws(
    () => recordOwnerAlertDelivery(db, prod, "x", DUE),
    /EXECUTION_DISABLED/,
  );
}));

test("restart: dead-letter stays visible and silent; quarantined binding persists, never sent or retargeted", async () => {
  const path = join(tmpdir(), `owner-alert-${process.pid}-${Date.now()}-a.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    const c1 = cfg();
    const policy = createOwnerAlertPolicy(c1);
    // Dead-letter path: the full six-attempt budget is consumed by UNKNOWNs.
    dispatchedOp(db);
    reconcileOwnerAlerts(db, "TEST_ONLY", c1, KEYRING, DUE);
    const transport = new SyntheticOwnerAlertTransport(new Array(6).fill("UNKNOWN"));
    let now = DUE;
    for (const gap of [0, 5 * MIN, 15 * MIN, HOUR, 4 * HOUR, 8 * HOUR]) {
      now = new Date(Date.parse(now) + gap).toISOString();
      await dispatchNextOwnerAlert({
        database: db, keyring: KEYRING, transport, policy, config: c1, now: () => now,
      });
    }
    assert.equal(count(db, "owner_alert_audit", "outcome='dead_letter'"), 1);
    assert.equal(count(db, "owner_alert_outbox"), 0);
    // Second case: a live pending notice that recipient-config drift quarantines.
    dispatchedOp(db, service3, quote3, "t-3", "disp-3");
    reconcileOwnerAlerts(db, "TEST_ONLY", c1, KEYRING, DUE);
    const c2 = cfg({ recipientConfigVersion: 2 });
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c2, KEYRING, DUE).quarantined, 1);

    db.close();
    db = new Sqlite(path);

    // Dead-letter survives restart: visible, never resurrected, and the absent
    // acceptance still forbids a reminder bypass.
    const deadCase = readOwnerAlertCases(db).find((c) => c.deadLetters === 1);
    assert.equal(deadCase?.unresolved, true);
    assert.equal(deadCase?.firstNoticeAcceptedAt, null);
    assert.equal(count(db, "owner_alert_audit", "outcome='dead_letter'"), 1);
    const farLater = new Date(Date.parse(DUE) + 96 * HOUR).toISOString();
    const post = reconcileOwnerAlerts(db, "TEST_ONLY", c2, KEYRING, farLater);
    assert.equal(post.noticesEnqueued, 0);
    assert.equal(post.remindersEnqueued, 0);
    assert.equal(count(db, "owner_alert_outbox", "status != 'quarantined'"), 0);

    // The quarantined binding survives restart: still quarantined and visible,
    // and still never claimed, retargeted, or delivered.
    assert.equal(count(db, "owner_alert_outbox", "status='quarantined'"), 1);
    const qCase = readOwnerAlertCases(db).find((c) => c.noticesQuarantined === 1);
    assert.equal(qCase?.unresolved, true);
    const transport2 = new SyntheticOwnerAlertTransport();
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport: transport2,
      policy: createOwnerAlertPolicy(c2), config: c2, now: () => farLater,
    }), { outcome: "idle" });
    assert.equal(transport2.calls.length, 0);
    // Even back under the original binding it stays quarantined — no implicit undo.
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport: transport2, policy, config: c1, now: () => farLater,
    }), { outcome: "idle" });
    assert.equal(count(db, "owner_alert_outbox", "status='quarantined'"), 1);
    assert.equal(readOwnerAlertCases(db).find((c) => c.noticesQuarantined === 1)?.unresolved, true);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test("restart: accepted-unACKed anchors, one-shot reminder budget, late receipts and ACK all persist", async () => {
  const path = join(tmpdir(), `owner-alert-${process.pid}-${Date.now()}-b.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    const c = cfg();
    const policy = createOwnerAlertPolicy(c);
    const op = dispatchedOp(db, service2, quote2, "t-2", "disp-2");
    reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, DUE);
    const transport = new SyntheticOwnerAlertTransport();
    await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport, policy, config: c, now: () => DUE,
    });
    const key = (db.prepare("SELECT event_key FROM owner_alert_events").all()[0] as { event_key: string }).event_key;
    assert.equal(recordOwnerAlertDelivery(db, "TEST_ONLY", key, DUE), "DELIVERED");

    db.close();
    db = new Sqlite(path);

    // Acceptance + delivery anchors survive restart; a replayed receipt stays REPLAY.
    let view = readOwnerAlertCases(db)[0];
    assert.equal(view?.unresolved, true);
    assert.equal(view?.firstNoticeAcceptedAt, DUE);
    assert.equal(view?.noticesAccepted, 1);
    assert.equal(view?.noticesDelivered, 1);
    assert.equal(recordOwnerAlertDelivery(db, "TEST_ONLY", key, DUE), "REPLAY");
    assert.equal(readOwnerAlertCases(db)[0]?.noticesDelivered, 1);

    // The single reminder fires after restart, at the same persisted anchor.
    const remAt = new Date(Date.parse(DUE) + 24 * HOUR + 1000).toISOString();
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, remAt).remindersEnqueued, 1);

    db.close();
    db = new Sqlite(path);

    // Its own six-attempt budget survives restart; exhaustion dead-letters it too.
    const failAll = new SyntheticOwnerAlertTransport(new Array(6).fill("UNKNOWN"));
    let now = remAt;
    for (const gap of [0, 5 * MIN, 15 * MIN]) {
      now = new Date(Date.parse(now) + gap).toISOString();
      await dispatchNextOwnerAlert({
        database: db, keyring: KEYRING, transport: failAll, policy, config: c, now: () => now,
      });
    }

    // Mid-budget restart: partially consumed budget, lease and schedule persist.
    db.close();
    db = new Sqlite(path);
    const midRow = db.prepare(
      "SELECT attempts,status,next_attempt_at,reminder_ordinal FROM owner_alert_outbox",
    ).all()[0] as
      { attempts: number; status: string; next_attempt_at: string; reminder_ordinal: number };
    assert.equal(midRow.status, "pending");
    assert.equal(midRow.attempts, 3);
    assert.equal(midRow.reminder_ordinal, 1);
    assert.equal(midRow.next_attempt_at, new Date(Date.parse(now) + HOUR).toISOString());

    for (const gap of [HOUR, 4 * HOUR, 8 * HOUR]) {
      now = new Date(Date.parse(now) + gap).toISOString();
      await dispatchNextOwnerAlert({
        database: db, keyring: KEYRING, transport: failAll, policy, config: c, now: () => now,
      });
    }
    assert.equal(count(db, "owner_alert_audit", "outcome='dead_letter'"), 1);
    assert.equal(failAll.calls.length, 6);
    assert.equal(failAll.calls.every((d) => d.reminderOrdinal === 1), true);

    db.close();
    db = new Sqlite(path);

    // The consumed ordinal is durable: no ordinal 2 ever, even much later.
    const later = new Date(Date.parse(DUE) + 96 * HOUR).toISOString();
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, later).remindersEnqueued, 0);
    view = readOwnerAlertCases(db)[0];
    assert.equal(view?.unresolved, true); // dead-lettered reminder cannot hide the case
    assert.equal(view?.deadLetters, 1);
    assert.equal(view?.firstNoticeAcceptedAt, DUE);

    // ACK survives restart, stays non-resolution, and still blocks reminders.
    const ack = {
      eventKey: key, actorRole: "HUMAN_OWNER",
      recipientRef: "HUMAN_OWNER", recipientConfigVersion: 1,
    };
    assert.equal(recordOwnerAlertAck(db, "TEST_ONLY", ack, later), "ACKED");
    db.close();
    db = new Sqlite(path);
    view = readOwnerAlertCases(db)[0];
    assert.equal(view?.ownerAckAt, later);
    assert.equal(view?.unresolved, true);
    assert.equal(recordOwnerAlertAck(db, "TEST_ONLY", ack, later), "REPLAY");
    assert.equal(reconcileOwnerAlerts(db, "TEST_ONLY", c, KEYRING, later).remindersEnqueued, 0);
    assert.equal(readRenewalOperation(db, op)?.state, "DISPATCH_AUTHORIZED");

    // Late + duplicate evidence receipts keep append-only facts and anchors intact.
    assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence({
      dispatchId: "disp-2", resourceKey: "service:22",
    }), later), "RECORDED");
    assert.equal(recordRenewalEvidence(db, "TEST_ONLY", op, evidence({
      dispatchId: "disp-2", resourceKey: "service:22",
    }), later), "REPLAY");
    assert.equal(count(db, "wallet_renewal_contradictions"), 0);
    db.close();
    db = new Sqlite(path);
    view = readOwnerAlertCases(db)[0];
    assert.equal(view?.firstNoticeAcceptedAt, DUE); // anchor never resets
    assert.equal(view?.unresolved, false); // trusted evidence resolves the case
    assert.equal(readRenewalOperation(db, op)?.state, "EVIDENCE_RECORDED");
    assert.equal(count(db, "wallet_renewal_contradictions"), 0);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});

test("reminder inherits the event's pinned binding — drift quarantines it, never retargets", async () => {
  const path = join(tmpdir(), `owner-alert-${process.pid}-${Date.now()}-rem.db`);
  let db = new Sqlite(path);
  try {
    seed(db);
    const c1 = cfg({ recipientConfigVersion: 1 });
    const c2 = cfg({ recipientConfigVersion: 2 });
    const policy1 = createOwnerAlertPolicy(c1);
    dispatchedOp(db);
    reconcileOwnerAlerts(db, "TEST_ONLY", c1, KEYRING, DUE);
    const transport = new SyntheticOwnerAlertTransport();
    await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport, policy: policy1, config: c1, now: () => DUE,
    });
    assert.equal(transport.calls.length, 1); // initial notice accepted under v1

    // Config moves to v2; +24h later the reminder must stay bound to v1.
    const remAt = new Date(Date.parse(DUE) + 24 * HOUR + 1000).toISOString();
    const rem = reconcileOwnerAlerts(db, "TEST_ONLY", c2, KEYRING, remAt);
    assert.equal(rem.remindersEnqueued, 1);
    assert.equal(rem.quarantined, 1); // drifted reminder parked visibly, same txn
    const row = db.prepare(
      "SELECT status,reminder_ordinal,recipient_config_version FROM owner_alert_outbox",
    ).all()[0] as { status: string; reminder_ordinal: number; recipient_config_version: number };
    assert.equal(row.status, "quarantined");
    assert.equal(row.reminder_ordinal, 1);
    assert.equal(row.recipient_config_version, 1); // pinned, NOT retargeted to v2
    assert.equal(count(db, "owner_alert_audit", "outcome='quarantined'"), 1);
    // Zero sends under the new config — no fallback recipient exists.
    assert.deepEqual(await dispatchNextOwnerAlert({
      database: db, keyring: KEYRING, transport,
      policy: createOwnerAlertPolicy(c2), config: c2, now: () => remAt,
    }), { outcome: "idle" });
    assert.equal(transport.calls.length, 1);
    // ACK binds the pinned v1 version — v2 is rejected, v1 still works.
    const eventKey = (db.prepare("SELECT event_key FROM owner_alert_events").all()[0] as
      { event_key: string }).event_key;
    const ack = { eventKey, actorRole: "HUMAN_OWNER", recipientRef: "HUMAN_OWNER" };
    assert.throws(
      () => recordOwnerAlertAck(db, "TEST_ONLY", { ...ack, recipientConfigVersion: 2 }, remAt),
      /ACK_FORBIDDEN/,
    );
    assert.equal(
      recordOwnerAlertAck(db, "TEST_ONLY", { ...ack, recipientConfigVersion: 1 }, remAt), "ACKED",
    );

    db.close();
    db = new Sqlite(path);

    // Restart: quarantine + pinned binding + ACK all persist; ordinal stays consumed.
    const row2 = db.prepare(
      "SELECT status,reminder_ordinal,recipient_config_version FROM owner_alert_outbox",
    ).all()[0] as { status: string; reminder_ordinal: number; recipient_config_version: number };
    assert.equal(row2.status, "quarantined");
    assert.equal(row2.recipient_config_version, 1);
    const view = readOwnerAlertCases(db)[0];
    assert.equal(view?.unresolved, true);
    assert.equal(view?.noticesQuarantined, 1);
    assert.equal(view?.ownerAckAt, remAt);
    const later = new Date(Date.parse(remAt) + 72 * HOUR).toISOString();
    const rerun = reconcileOwnerAlerts(db, "TEST_ONLY", c2, KEYRING, later);
    assert.equal(rerun.remindersEnqueued, 0); // never an ordinal 2
    assert.equal(count(db, "owner_alert_outbox", "status != 'quarantined'"), 0);
  } finally {
    db.close();
    rmSync(path, { force: true });
  }
});
