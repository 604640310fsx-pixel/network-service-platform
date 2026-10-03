import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import type { DatabaseConnection } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "./auth/helpers.js";
import { CSRF_KEY, TEST_NOW, TOKEN_KEYRING, insertWebSession } from "./payment/helpers.js";

const NOW = "2026-08-21T00:00:00.000Z";
const ENDS = "2026-09-01T00:00:00.000Z";

type Session = ReturnType<typeof insertWebSession>;
type App = FastifyInstance;

function walletApp(database: DatabaseConnection): App {
  return buildApp({
    wallet: {
      database,
      tokenHmacKeyring: TOKEN_KEYRING,
      csrfSigningKey: CSRF_KEY,
      now: () => new Date(TEST_NOW),
    },
  });
}

function user(database: DatabaseConnection, email: string, role: "user" | "admin" = "user") {
  const id = insertAuthenticationUser(database, { email, passwordHash: "hash", status: "active", role });
  return { id, session: insertWebSession(database, id) };
}

/** Owned open paid service on the seeded local-isp/us/us-verizon/month-1 plan (¥79). */
function seedService(database: DatabaseConnection, ownerId: number, adminId: number, status = "open"): number {
  database
    .prepare(
      `INSERT INTO orders (
         order_ref, idempotency_key, request_fingerprint, user_id,
         type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
         amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'local-isp', 'us', 'us-verizon', NULL, 'month-1', 'SUBSCRIBE-CATALOG-V1',
         7900, 'CNY', 'w@example.test', '[]', NULL, 'paid', ?, ?)`,
    )
    .run(`WDL${ownerId}${status.length}`, `wi-${ownerId}-${status}`, `wf-${ownerId}`, ownerId, NOW, NOW);
  const orderId = Number(
    (database.prepare("SELECT id FROM orders WHERE idempotency_key = ?").all(`wi-${ownerId}-${status}`)[0] as { id: number }).id,
  );
  database
    .prepare(
      `INSERT INTO payments (
         order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
         trade_no, alipay_trade_status, paid_at, created_at, updated_at
       ) VALUES (?, ?, 'alipay_page', 'w-app', 7900, 'CNY', 'paid', ?, 'TRADE_SUCCESS', ?, ?, ?)`,
    )
    .run(orderId, `wt-${ownerId}-${status}`, `wt-${ownerId}-${status}`, NOW, NOW, NOW);
  const paymentId = Number(
    (database.prepare("SELECT id FROM payments WHERE order_id = ?").all(orderId)[0] as { id: number }).id,
  );
  database
    .prepare(
      `INSERT INTO services (payment_id, status, opened_by_admin_id, opened_at, ends_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(paymentId, status, status === "open" ? adminId : null, status === "open" ? NOW : null, ENDS, NOW, NOW);
  return Number(
    (database.prepare("SELECT id FROM services WHERE payment_id = ?").all(paymentId)[0] as { id: number }).id,
  );
}

const get = (app: App, url: string, session: Session | null) =>
  app.inject({ method: "GET", url, headers: session ? { cookie: session.cookie } : {} });
const put = (app: App, url: string, session: Session | null, payload: unknown, csrf?: string | null) =>
  app.inject({
    method: "PUT", url,
    headers: {
      "content-type": "application/json",
      ...(session ? { cookie: session.cookie } : {}),
      ...(csrf !== null && (csrf ?? session?.csrfToken) ? { "x-csrf-token": (csrf ?? session?.csrfToken) as string } : {}),
    },
    payload: payload as Record<string, unknown>,
  });

test("wallet balance: authenticated CNY fen, zero without account, unauthorized without session", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = walletApp(database);
    const owner = user(database, "w1@example.test");
    let res = await get(app, "/api/me/wallet", null);
    assert.equal(res.statusCode, 401);
    res = await get(app, "/api/me/wallet", owner.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { balanceFen: 0, currency: "CNY" });
    database.prepare("INSERT INTO wallet_accounts(user_id,balance_fen) VALUES (?,1234)").run(owner.id);
    res = await get(app, "/api/me/wallet", owner.session);
    assert.deepEqual(res.json(), { balanceFen: 1234, currency: "CNY" });
    await app.close();
  });
});

test("renewal-quote: owner gets server-derived quote; foreign/missing/bad period share 404; owned unavailable 409", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = walletApp(database);
    const owner = user(database, "w2@example.test");
    const other = user(database, "w3@example.test");
    const serviceId = seedService(database, owner.id, other.id);
    let res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=MONTHLY`, owner.session);
    assert.equal(res.statusCode, 200);
    const { quote } = res.json() as { quote: Record<string, unknown> };
    assert.equal(quote.priceFen, 7900);
    assert.equal(quote.currency, "CNY");
    assert.equal(quote.durationId, "month-1");
    assert.equal(quote.period, "MONTHLY");
    assert.equal(quote.previousEndsAt, ENDS);
    assert.equal(quote.newEndsAt, "2026-10-01T00:00:00.000Z");
    assert.ok(typeof quote.key === "string" && (quote.key as string).includes("SUBSCRIBE-CATALOG-V1"));
    res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=MONTHLY`, other.session);
    assert.equal(res.statusCode, 404);
    res = await get(app, "/api/me/services/999/renewal-quote?period=MONTHLY", owner.session);
    assert.equal(res.statusCode, 404);
    res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=NOPE`, owner.session);
    assert.equal(res.statusCode, 404);
    res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=QUARTERLY`, owner.session);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "quote_unavailable");
    res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=MONTHLY`, null);
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});

test("renewal-consent: GET snapshot, PUT enable/disable with owner+CSRF+revision, catalog-free disable", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = walletApp(database);
    const owner = user(database, "w4@example.test");
    const admin = user(database, "w5@example.test", "admin");
    const foreign = user(database, "w6@example.test");
    const serviceId = seedService(database, owner.id, admin.id);
    const url = `/api/me/services/${serviceId}/renewal-consent`;
    let res = await get(app, url, owner.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().consent.state, "DISABLED");
    assert.equal(res.json().consent.revision, 0);
    res = await get(app, url, foreign.session);
    assert.equal(res.statusCode, 404);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true }, null);
    assert.equal(res.statusCode, 403);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, priceFen: 1 });
    assert.equal(res.statusCode, 400);
    res = await put(app, url, foreign.session, { period: "MONTHLY", expectedRevision: 0, enabled: true });
    assert.equal(res.statusCode, 404);
    res = await put(app, url, admin.session, { period: "MONTHLY", expectedRevision: 0, enabled: true });
    assert.equal(res.statusCode, 404);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().revision, 1);
    res = await get(app, url, owner.session);
    const consent = res.json().consent;
    assert.equal(consent.state, "ENABLED");
    assert.equal(consent.revision, 1);
    assert.equal(consent.period, "MONTHLY");
    assert.equal(consent.priceFen, 7900);
    assert.equal(consent.durationId, "month-1");
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "revision_conflict");
    // Disable still works with the catalog row gone — only owner + revision are needed.
    database.prepare("DELETE FROM sellable_plans WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND duration_id='month-1'").run();
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 1, enabled: true });
    assert.equal(res.statusCode, 409);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 1, enabled: false });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().revision, 2);
    res = await get(app, url, owner.session);
    assert.equal(res.json().consent.state, "DISABLED");
    assert.equal(res.json().consent.priceFen, null);
    await app.close();
  });
});
