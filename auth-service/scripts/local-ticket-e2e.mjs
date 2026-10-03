#!/usr/bin/env node
/* TEST-ONLY local ticket+wallet E2E fixture for NSP-CUSTOMER-PORTAL-INTEGRATION-20261004.
   Runs the real auth-service buildApp against a disposable SQLite file with
   synthetic identities on 127.0.0.1 so the customer/admin ticket UI and the
   wallet/renewal endpoints can be exercised end to end (create/reply/image
   download/draft/purchase+grant link, balance, renewal quote, consent).

   - Loopback only; every identity, order, grant and session is synthetic.
   - No production data, credentials, provider calls, or persistent writes.
   - Requires `npm run build` first (imports dist/). Ctrl+C to stop; the
     temporary database directory is left under the OS temp dir. */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { initializeDatabase } from "../dist/src/db.js";
import { buildApp } from "../dist/src/app.js";
import { insertAuthenticationUser } from "../dist/test/auth/helpers.js";
import {
  CSRF_KEY,
  TOKEN_KEYRING,
  insertWebSession,
  paymentDependencies,
} from "../dist/test/payment/helpers.js";

const PORT = Number(process.env.FIXTURE_PORT ?? 8899);
const here = dirname(fileURLToPath(import.meta.url));
const workdir = mkdtempSync(join(tmpdir(), "nsp-ticket-e2e-"));
const database = initializeDatabase(join(workdir, "auth.sqlite"));

const nowIso = () => new Date().toISOString();
const customerId = insertAuthenticationUser(database, {
  email: "customer@fixture.test",
  passwordHash: "fixture",
  status: "active",
});
const adminId = insertAuthenticationUser(database, {
  email: "admin@fixture.test",
  passwordHash: "fixture",
  status: "active",
  role: "admin",
});
const customer = insertWebSession(database, customerId);
const admin = insertWebSession(database, adminId);

// insertWebSession stamps TEST_NOW; shift rows to the real clock so the
// disposable sessions stay valid for the duration of the fixture run.
const started = nowIso();
const expiry = new Date(Date.now() + 30 * 24 * 3_600_000).toISOString();
database
  .prepare("UPDATE session_families SET created_at = ?")
  .run(started);
database
  .prepare("UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ?")
  .run(started, started, expiry);

// One owned open service (purchase link) and one active opened gift
// (grant link) for the customer.
const orderRef = "DLFIXTURE0001";
database
  .prepare(
    `INSERT INTO orders (
       order_ref, idempotency_key, request_fingerprint, user_id,
       type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
       amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
     ) VALUES (?, 'fx-idem-1', 'fx-fp-1', ?, 'local-isp', 'us', 'us-verizon', NULL,
       'month-1', 'v1', 1000, 'CNY', 'fixture@example.test', '[]', NULL, 'paid', ?, ?)`,
  )
  .run(orderRef, customerId, started, started);
const orderId = database.prepare("SELECT id FROM orders WHERE order_ref = ?").get(orderRef).id;
database
  .prepare(
    `INSERT INTO payments (
       order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
       trade_no, alipay_trade_status, last_queried_at, close_reason,
       paid_at, closed_at, created_at, updated_at, reserved_until
     ) VALUES (?, 'fx-out-1', 'alipay_page', 'fx-app', 1000, 'CNY', 'paid',
       'fx-trade-1', 'TRADE_SUCCESS', NULL, NULL, ?, NULL, ?, ?, NULL)`,
  )
  .run(orderId, started, started, started);
const paymentId = database.prepare("SELECT id FROM payments WHERE order_id = ?").get(orderId).id;
database
  .prepare(
    `INSERT INTO services (
       payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at, ends_at
     ) VALUES (?, 'open', ?, ?, ?, ?, ?)`,
  )
  .run(paymentId, adminId, started, started, started, expiry);
database
  .prepare(
    `INSERT INTO admin_grants (
       user_id, granted_by_admin_id, label, starts_at, ends_at, status, reason,
       created_at, updated_at, delivery_status, opened_at
     ) VALUES (?, ?, 'Fixture Gift', ?, NULL, 'active', NULL, ?, ?, 'open', ?)`,
  )
  .run(customerId, adminId, started, started, started, started);
const grantId = database.prepare("SELECT id FROM admin_grants WHERE user_id = ?").get(customerId).id;
const serviceId = database.prepare("SELECT id FROM services WHERE payment_id = ?").get(paymentId).id;

// Wallet fixture: known synthetic CNY balance on the customer's account, plus a
// foreign-owned open paid service so owner checks return the uniform 404.
const BALANCE_FEN = 30000;
database
  .prepare("INSERT INTO wallet_accounts (user_id, balance_fen) VALUES (?, ?)")
  .run(customerId, BALANCE_FEN);
const foreignId = insertAuthenticationUser(database, {
  email: "foreign@fixture.test",
  passwordHash: "fixture",
  status: "active",
});
database
  .prepare(
    `INSERT INTO orders (
       order_ref, idempotency_key, request_fingerprint, user_id,
       type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
       amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
     ) VALUES ('DLFIXTURE0002', 'fx-idem-2', 'fx-fp-2', ?, 'local-isp', 'us', 'us-verizon', NULL,
       'month-1', 'v1', 1000, 'CNY', 'foreign@fixture.test', '[]', NULL, 'paid', ?, ?)`,
  )
  .run(foreignId, started, started);
const foreignOrderId = database.prepare("SELECT id FROM orders WHERE order_ref = 'DLFIXTURE0002'").get().id;
database
  .prepare(
    `INSERT INTO payments (
       order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
       trade_no, alipay_trade_status, paid_at, created_at, updated_at
     ) VALUES (?, 'fx-out-2', 'alipay_page', 'fx-app', 1000, 'CNY', 'paid',
       'fx-trade-2', 'TRADE_SUCCESS', ?, ?, ?)`,
  )
  .run(foreignOrderId, started, started, started);
const foreignPaymentId = database.prepare("SELECT id FROM payments WHERE order_id = ?").get(foreignOrderId).id;
database
  .prepare(
    `INSERT INTO services (
       payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at, ends_at
     ) VALUES (?, 'open', ?, ?, ?, ?, ?)`,
  )
  .run(foreignPaymentId, adminId, started, started, started, expiry);
const foreignServiceId = database.prepare("SELECT id FROM services WHERE payment_id = ?").get(foreignPaymentId).id;

// Order-close fixture: a customer-owned UNPAID pending order (buyer cancel and
// admin close target) and a paid order whose service is still pending_open
// (admin close → AWAITING_POLICY refund case). The foreign paid order ref gives
// the buyer cancel route a uniform 404. All rows are synthetic and disposable.
const unpaidOrderRef = "DLFIXTURE0003";
database
  .prepare(
    `INSERT INTO orders (
       order_ref, idempotency_key, request_fingerprint, user_id,
       type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
       amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
     ) VALUES (?, 'fx-idem-3', 'fx-fp-3', ?, 'local-isp', 'us', 'us-verizon', NULL,
       'month-1', 'v1', 1000, 'CNY', 'fixture@example.test', '[]', NULL, 'pending', ?, ?)`,
  )
  .run(unpaidOrderRef, customerId, started, started);
const unpaidOrderId = database.prepare("SELECT id FROM orders WHERE order_ref = ?").get(unpaidOrderRef).id;
database
  .prepare(
    `INSERT INTO payments (
       order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
       created_at, updated_at, reserved_until
     ) VALUES (?, 'fx-out-3', 'alipay_page', 'app-123', 1000, 'CNY', 'pending', ?, ?, ?)`,
  )
  .run(unpaidOrderId, started, started, expiry);
const pendingOpenOrderRef = "DLFIXTURE0004";
database
  .prepare(
    `INSERT INTO orders (
       order_ref, idempotency_key, request_fingerprint, user_id,
       type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
       amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
     ) VALUES (?, 'fx-idem-4', 'fx-fp-4', ?, 'local-isp', 'us', 'us-verizon', NULL,
       'month-1', 'v1', 1000, 'CNY', 'fixture@example.test', '[]', NULL, 'paid', ?, ?)`,
  )
  .run(pendingOpenOrderRef, customerId, started, started);
const pendingOpenOrderId = database.prepare("SELECT id FROM orders WHERE order_ref = ?").get(pendingOpenOrderRef).id;
database
  .prepare(
    `INSERT INTO payments (
       order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
       trade_no, alipay_trade_status, paid_at, created_at, updated_at
     ) VALUES (?, 'fx-out-4', 'alipay_page', 'app-123', 1000, 'CNY', 'paid',
       'fx-trade-4', 'TRADE_SUCCESS', ?, ?, ?)`,
  )
  .run(pendingOpenOrderId, started, started, started);
const pendingOpenPaymentId = database.prepare("SELECT id FROM payments WHERE order_id = ?").get(pendingOpenOrderId).id;
database
  .prepare(
    `INSERT INTO services (
       payment_id, status, ends_at, created_at, updated_at
     ) VALUES (?, 'pending_open', ?, ?, ?)`,
  )
  .run(pendingOpenPaymentId, expiry, started, started);

const paymentDeps = paymentDependencies(database);
// The fake provider: trades stay WAIT_BUYER_PAY until alipay.trade.close runs,
// then report TRADE_CLOSED on the authoritative requery. No real provider.
paymentDeps.sdk.queryResponse = (ref) => ({
  code: "10000",
  tradeStatus: paymentDeps.sdk.closeCalls.includes(ref) ? "TRADE_CLOSED" : "WAIT_BUYER_PAY",
  outTradeNo: ref,
  tradeNo: `fx-qt-${ref}`,
  totalAmount: "10.00",
});

const app = buildApp({
  auth: {
    database,
    nodeEnv: "test",
    tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: TOKEN_KEYRING,
    csrfSigningKey: CSRF_KEY,
  },
  payment: { ...paymentDeps, now: () => new Date() },
  tickets: {
    database,
    tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: TOKEN_KEYRING,
    csrfSigningKey: CSRF_KEY,
  },
  wallet: {
    database,
    tokenHmacKeyring: TOKEN_KEYRING,
    csrfSigningKey: CSRF_KEY,
    payment: { appId: paymentDeps.appId, sellerId: paymentDeps.sellerId, sdk: paymentDeps.sdk },
  },
});

await app.listen({ host: "127.0.0.1", port: PORT });
const base = `http://127.0.0.1:${PORT}`;
process.stdout.write(
  `${JSON.stringify(
    {
      fixture: "TEST-ONLY local ticket E2E (disposable)",
      baseUrl: base,
      db: join(workdir, "auth.sqlite"),
      customer: {
        userId: customerId,
        cookie: customer.cookie,
        csrfToken: customer.csrfToken,
      },
      admin: {
        userId: adminId,
        cookie: admin.cookie,
        csrfToken: admin.csrfToken,
      },
      links: { serviceOrderRef: orderRef, serviceGrantId: grantId },
      wallet: {
        serviceId,
        foreignServiceId,
        balanceFen: BALANCE_FEN,
        currency: "CNY",
        supportedPeriod: "MONTHLY",
        durationId: "month-1",
        planPriceFen: 7900,
        unpaidOrderRef,
        unpaidOrderId,
        pendingOpenOrderId,
        openOrderId: orderId,
        foreignOrderRef: "DLFIXTURE0002",
      },
      checks: {
        me: `curl -s ${base}/api/auth/me -H 'cookie: <customer.cookie>'`,
        createTicket: `curl -s -X POST ${base}/api/me/tickets -H 'content-type: application/json' -H 'cookie: <customer.cookie>' -H 'x-csrf-token: <customer.csrfToken>' -d '{"subject":"fixture","body":"hello","serviceGrantId":${grantId}}'`,
      },
      note: "Browser: set the __Host-web_session cookie to the raw token after '=' and use csrfToken for writes.",
    },
    null,
    2,
  )}\n`,
);
process.on("SIGINT", async () => {
  await app.close();
  database.close();
  process.exit(0);
});
