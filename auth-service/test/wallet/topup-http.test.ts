import assert from "node:assert/strict";
import test from "node:test";
import type { FastifyInstance } from "fastify";
import type { DatabaseConnection } from "../../src/db.js";
import { buildApp } from "../../src/app.js";
import { createIdempotentTopupIntent, readOwnedTopup } from "../../src/wallet/candidate.js";
import { TOPUP_IDEMPOTENCY_CANDIDATE_DDL } from "../../src/wallet/topup-idempotency.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { CSRF_KEY, TEST_NOW, TOKEN_KEYRING, insertWebSession } from "../payment/helpers.js";
import { registerLocalTopupAdapter, syntheticNotice } from "./local-topup-adapter.js";

const SECRET = Buffer.alloc(32, 0x51);
const MERCHANT = "local-test-merchant";
const NOW = new Date("2026-10-07T00:00:00.000Z");
const CHECKOUT = { mode: "TEST_ONLY", runtime: "test", checkoutUrl: (topupId: string) => `/api/__test/topups/${topupId}/checkout` } as const;

function fixtureUser(database: DatabaseConnection, email: string) {
  const id = insertAuthenticationUser(database, { email, passwordHash: "fixture-hash", status: "active" });
  return { id, session: insertWebSession(database, id) };
}

async function withTopupApp(run: (app: FastifyInstance, db: DatabaseConnection,
  owner: ReturnType<typeof fixtureUser>, other: ReturnType<typeof fixtureUser>) => Promise<void>) {
  const old = process.env.TEST_ONLY;
  process.env.TEST_ONLY = "1";
  try {
    await withAuthenticationDatabase(async (db) => {
      db.exec(TOPUP_IDEMPOTENCY_CANDIDATE_DDL);
      const owner = fixtureUser(db, "topup-owner@example.test");
      const other = fixtureUser(db, "topup-other@example.test");
      const app = buildApp({ wallet: { database: db, tokenHmacKeyring: TOKEN_KEYRING,
        csrfSigningKey: CSRF_KEY, now: () => TEST_NOW, topupCheckout: CHECKOUT } });
      registerLocalTopupAdapter(app, db, SECRET, MERCHANT, () => NOW);
      try { await run(app, db, owner, other); } finally { await app.close(); }
    });
  } finally {
    if (old === undefined) delete process.env.TEST_ONLY;
    else process.env.TEST_ONLY = old;
  }
}

function create(app: FastifyInstance, session: ReturnType<typeof insertWebSession> | null,
  key: string | null, payload: unknown = { amountFen: 1000 }, csrf = true) {
  return app.inject({ method: "POST", url: "/api/me/wallet/topups", payload: payload as object,
    headers: { "content-type": "application/json", ...(session ? { cookie: session.cookie } : {}),
      ...(session && csrf ? { "x-csrf-token": session.csrfToken } : {}),
      ...(key === null ? {} : { "idempotency-key": key }) } });
}

function notice(orderRef: string, amountFen = 1000) {
  return syntheticNotice(SECRET, { orderRef, providerTradeNo: `synthetic-${orderRef}`,
    merchantId: MERCHANT, amountFen, currency: "CNY", finalStatus: "SUCCESS" });
}

test("topup HTTP owner, CSRF, exact body, idempotency and concurrent one-intent", async () => {
  await withTopupApp(async (app, db, owner, other) => {
    assert.equal((await create(app, null, "key-1")).statusCode, 401);
    assert.equal((await create(app, owner.session, "key-1", { amountFen: 1000 }, false)).statusCode, 403);
    assert.equal((await create(app, owner.session, null)).statusCode, 400);
    for (const payload of [{ amountFen: 0 }, { amountFen: 1.5 }, { amountFen: Number.MAX_SAFE_INTEGER + 1 },
      { amountFen: 1000, userId: other.id }, { amountFen: 1000, currency: "USD" },
      { amountFen: 1000, status: "SUCCEEDED" }]) {
      assert.equal((await create(app, owner.session, "key-1", payload)).statusCode, 400);
    }
    const responses = await Promise.all(Array.from({ length: 8 }, () => create(app, owner.session, "key-1")));
    assert.ok(responses.every((response) => response.statusCode === 200));
    const first = responses[0]!.json();
    assert.ok(responses.every((response) => response.json().topupId === first.topupId));
    assert.match(first.topupId, /^WT[A-Za-z0-9_-]{32}$/);
    assert.deepEqual(first.checkout, { kind: "REDIRECT", url: `/api/__test/topups/${first.topupId}/checkout` });
    assert.equal(first.status, "PENDING");
    assert.equal(first.amountFen, 1000);
    assert.equal(first.currency, "CNY");
    assert.equal(first.succeededAt, null);
    assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_topups").all()[0] as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_topup_idempotency").all()[0] as { n: number }).n, 1);
    const conflict = await create(app, owner.session, "key-1", { amountFen: 1001 });
    assert.equal(conflict.statusCode, 409);
    assert.equal(conflict.json().error.code, "idempotency_conflict");
    assert.equal((await app.inject({ method: "GET", url: `/api/me/wallet/topups/${first.topupId}`,
      headers: { cookie: other.session.cookie } })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/api/me/wallet/topups/${first.topupId}`,
      headers: { cookie: owner.session.cookie } })).json().status, "PENDING");
    assert.equal((await create(app, other.session, "key-1")).statusCode, 200);
  });
});

test("signed local callback rejects every invalid fact, credits once, and rolls back on ledger failure", async () => {
  await withTopupApp(async (app, db, owner) => {
    const topupId = (await create(app, owner.session, "key-2")).json().topupId as string;
    const valid = notice(topupId);
    const send = (payload: unknown) => app.inject({ method: "POST", url: "/api/__test/topups/notify",
      headers: { "content-type": "application/json" }, payload: payload as object });
    const wrongOrder = `WT${"A".repeat(32)}`;
    for (const bad of [
      { ...valid, signature: "0".repeat(64) },
      syntheticNotice(SECRET, { ...valid, merchantId: "wrong" }),
      syntheticNotice(SECRET, { ...valid, orderRef: wrongOrder }),
      syntheticNotice(SECRET, { ...valid, amountFen: 1001 }),
      syntheticNotice(SECRET, { ...valid, currency: "USD" }),
      syntheticNotice(SECRET, { ...valid, finalStatus: "PENDING" }),
      { ...valid, signatureVerified: true },
    ]) assert.equal((await send(bad)).statusCode, 400);
    assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_ledger").all()[0] as { n: number }).n, 0);
    assert.equal((await app.inject({ method: "GET", url: "/api/me/wallet", headers: { cookie: owner.session.cookie } })).json().balanceFen, 0);
    db.exec("CREATE TRIGGER test_ledger_failure BEFORE INSERT ON wallet_ledger BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.equal((await send(valid)).statusCode, 503);
    assert.equal(readOwnedTopup(db, owner.id, topupId)?.status, "PENDING");
    assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_accounts").all()[0] as { n: number }).n, 0);
    db.exec("DROP TRIGGER test_ledger_failure");
    const callbacks = await Promise.all([send(valid), send(valid)]);
    assert.deepEqual(callbacks.map((response) => response.json().result).sort(), ["CREDITED", "REPLAY"]);
    const status = await app.inject({ method: "GET", url: `/api/me/wallet/topups/${topupId}`,
      headers: { cookie: owner.session.cookie } });
    assert.deepEqual(status.json(), { topupId, status: "SUCCEEDED", amountFen: 1000, currency: "CNY", succeededAt: NOW.toISOString() });
    assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_ledger WHERE kind='TOPUP'").all()[0] as { n: number }).n, 1);
    assert.equal((await app.inject({ method: "GET", url: "/api/me/wallet", headers: { cookie: owner.session.cookie } })).json().balanceFen, 1000);
  });
});

test("production startup rejects TEST_ONLY and ordinary runtime has no mock route or provider fallback", async () => {
  await withAuthenticationDatabase(async (db) => {
    db.exec(TOPUP_IDEMPOTENCY_CANDIDATE_DDL);
    const owner = fixtureUser(db, "topup-prod@example.test");
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      assert.throws(() => buildApp({ wallet: { database: db, tokenHmacKeyring: TOKEN_KEYRING,
        csrfSigningKey: CSRF_KEY, topupCheckout: CHECKOUT } }), /forbidden in production/);
    } finally {
      if (old === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = old;
    }
    const app = buildApp({ wallet: { database: db, tokenHmacKeyring: TOKEN_KEYRING, csrfSigningKey: CSRF_KEY,
      now: () => TEST_NOW } });
    try {
      assert.equal((await app.inject({ method: "GET", url: "/api/__test/topups/notify" })).statusCode, 404);
      assert.equal((await app.inject({ method: "POST", url: "/api/__test/topups/notify" })).statusCode, 404);
      assert.equal((await create(app, owner.session, "key-prod")).statusCode, 503);
      assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_topups").all()[0] as { n: number }).n, 0);
    } finally { await app.close(); }
  });
});

test("idempotency binding failure rolls the intent back", async () => {
  await withAuthenticationDatabase(async (db) => {
    db.exec(TOPUP_IDEMPOTENCY_CANDIDATE_DDL);
    const owner = fixtureUser(db, "topup-rollback@example.test");
    const actor = { userId: owner.id, sessionValid: true, csrfValid: true, isAdmin: false };
    db.exec("CREATE TRIGGER test_binding_failure BEFORE INSERT ON wallet_topup_idempotency BEGIN SELECT RAISE(ABORT,'test failure'); END");
    assert.throws(() => createIdempotentTopupIntent(db, actor, "key", `WT${"B".repeat(32)}`, 1000), /test failure/);
    assert.equal((db.prepare("SELECT count(*) AS n FROM wallet_topups").all()[0] as { n: number }).n, 0);
  });
});
