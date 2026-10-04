import assert from "node:assert/strict";
import test from "node:test";

import type { FastifyInstance } from "fastify";

import type { DatabaseConnection } from "../src/db.js";
import { buildApp } from "../src/app.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "./auth/helpers.js";
import { CSRF_KEY, FakeAlipaySdk, TEST_NOW, TOKEN_KEYRING, insertWebSession, paymentDependencies, queryResult, tradeNotExistResult } from "./payment/helpers.js";
import { applyAdminOrderClose, applyBuyerOrderCancellation } from "../src/wallet/candidate.js";

const NOW = "2026-08-21T00:00:00.000Z";
const ENDS = "2026-09-01T00:00:00.000Z";

type Session = ReturnType<typeof insertWebSession>;
type App = FastifyInstance;

function walletApp(database: DatabaseConnection, sdk?: FakeAlipaySdk): App {
  return buildApp({
    // payment 关闭时全局钩子对 /api/admin/services/* 返回 503（既有语义），
    // 需要 admin 路由覆盖的用例必须同时注入启用态 payment。
    ...(sdk === undefined ? {} : { payment: paymentDependencies(database, sdk) }),
    wallet: {
      database,
      tokenHmacKeyring: TOKEN_KEYRING,
      csrfSigningKey: CSRF_KEY,
      now: () => new Date(TEST_NOW),
      ...(sdk === undefined ? {} : { payment: { appId: "app-123", sellerId: "seller-456", sdk } }),
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

/** Order/payment/(optional service) row set on the real payment schema; the seeded
    payment appId matches the walletApp provider wiring. */
function seedOrder(
  database: DatabaseConnection,
  ownerId: number,
  input: {
    readonly ref?: string;
    readonly orderStatus?: "pending" | "paid" | "closed";
    readonly paymentStatus?: "pending" | "paid" | "closed";
    readonly serviceStatus?: "pending_open" | "open" | null;
    readonly adminId?: number;
    readonly amountFen?: number;
    readonly tradeNo?: string | null;
  } = {},
): { readonly orderId: number; readonly orderRef: string; readonly paymentId: number; readonly serviceId: number | null } {
  const ref = input.ref ?? `WO${ownerId}-${input.orderStatus ?? "pending"}-${input.serviceStatus ?? "ns"}`;
  const amountFen = input.amountFen ?? 7900;
  database
    .prepare(
      `INSERT INTO orders (
         order_ref, idempotency_key, request_fingerprint, user_id,
         type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
         amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'local-isp', 'us', 'us-verizon', NULL, 'month-1', 'SUBSCRIBE-CATALOG-V1',
         ?, 'CNY', 'w@example.test', '[]', NULL, ?, ?, ?)`,
    )
    .run(ref, `i-${ref}`, `f-${ref}`, ownerId, amountFen, input.orderStatus ?? "pending", NOW, NOW);
  const orderId = Number((database.prepare("SELECT id FROM orders WHERE order_ref = ?").all(ref)[0] as { id: number }).id);
  database
    .prepare(
      `INSERT INTO payments (
         order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
         trade_no, alipay_trade_status, paid_at, created_at, updated_at, reserved_until
       ) VALUES (?, ?, 'alipay_page', 'app-123', ?, 'CNY', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      orderId, `out-${ref}`, amountFen, input.paymentStatus ?? "pending",
      input.tradeNo ?? null, input.paymentStatus === "paid" ? "TRADE_SUCCESS" : null,
      input.paymentStatus === "paid" ? NOW : null, NOW, NOW, "2026-09-15T00:00:00.000Z",
    );
  const paymentId = Number((database.prepare("SELECT id FROM payments WHERE order_id = ?").all(orderId)[0] as { id: number }).id);
  let serviceId: number | null = null;
  if (input.serviceStatus !== undefined && input.serviceStatus !== null) {
    database
      .prepare(
        `INSERT INTO services (payment_id, status, opened_by_admin_id, opened_at, ends_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        paymentId, input.serviceStatus, input.serviceStatus === "open" ? (input.adminId ?? ownerId) : null,
        input.serviceStatus === "open" ? NOW : null, ENDS, NOW, NOW,
      );
    serviceId = Number((database.prepare("SELECT id FROM services WHERE payment_id = ?").all(paymentId)[0] as { id: number }).id);
  }
  return { orderId, orderRef: ref, paymentId, serviceId };
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
const post = (app: App, url: string, session: Session | null, csrf?: string | null) =>
  app.inject({
    method: "POST", url,
    headers: {
      ...(session ? { cookie: session.cookie } : {}),
      ...(csrf !== null && (csrf ?? session?.csrfToken) ? { "x-csrf-token": (csrf ?? session?.csrfToken) as string } : {}),
    },
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
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: "k" }, null);
    assert.equal(res.statusCode, 403);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, priceFen: 1 });
    assert.equal(res.statusCode, 400);
    // enabled=true 必须携带买家实际看到的 GET-quote key。
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error.code, "invalid_request");
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: "" });
    assert.equal(res.statusCode, 400);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: 7 });
    assert.equal(res.statusCode, 400);
    res = await put(app, url, foreign.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: "k" });
    assert.equal(res.statusCode, 404);
    res = await put(app, url, admin.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: "k" });
    assert.equal(res.statusCode, 404);
    // 买家看到的 quote.key 原样回传 → 通过；条款只取 server 端。
    res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=MONTHLY`, owner.session);
    assert.equal(res.statusCode, 200);
    const seenKey = res.json().quote.key as string;
    // 看到报价后价格变化：旧 key 409 quote_changed，同意/修订/历史零写入。
    database.prepare("UPDATE sellable_plans SET price_fen=price_fen+1 WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND duration_id='month-1'").run();
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: seenKey });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "quote_changed");
    res = await get(app, url, owner.session);
    assert.equal(res.json().consent.state, "DISABLED");
    assert.equal(res.json().consent.revision, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM wallet_consent_history").all()[0] && (database.prepare("SELECT COUNT(*) AS n FROM wallet_consent_history").all()[0] as { n: number }).n, 0);
    res = await get(app, `/api/me/services/${serviceId}/renewal-quote?period=MONTHLY`, owner.session);
    const freshKey = res.json().quote.key as string;
    assert.notEqual(freshKey, seenKey);
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: freshKey });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().revision, 1);
    res = await get(app, url, owner.session);
    const consent = res.json().consent;
    assert.equal(consent.state, "ENABLED");
    assert.equal(consent.revision, 1);
    assert.equal(consent.period, "MONTHLY");
    assert.equal(consent.priceFen, 7901);
    assert.equal(consent.durationId, "month-1");
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 0, enabled: true, expectedQuoteKey: freshKey });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "revision_conflict");
    // Disable still works with the catalog row gone — only owner + revision are needed.
    database.prepare("DELETE FROM sellable_plans WHERE type_id='local-isp' AND region_id='us' AND isp_id='us-verizon' AND duration_id='month-1'").run();
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 1, enabled: true, expectedQuoteKey: "k" });
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

test("buyer order cancel: provider-observed unpaid close is atomic; paid/foreign/missing/CSRF boundaries hold", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const app = walletApp(database, sdk);
    const owner = user(database, "c1@example.test");
    const other = user(database, "c2@example.test");
    const unpaid = seedOrder(database, owner.id, { ref: "CANCEL-1", orderStatus: "pending", paymentStatus: "pending" });
    const paid = seedOrder(database, owner.id, {
      ref: "CANCEL-2", orderStatus: "paid", paymentStatus: "paid", tradeNo: "t-paid", serviceStatus: "pending_open",
    });
    const foreign = seedOrder(database, other.id, { ref: "CANCEL-3", orderStatus: "pending", paymentStatus: "pending" });
    sdk.queryResponse = (ref: string) =>
      queryResult({
        tradeStatus: sdk.closeCalls.includes(ref) ? "TRADE_CLOSED" : "WAIT_BUYER_PAY",
        outTradeNo: ref,
        totalAmount: "79.00",
      });
    let res = await post(app, `/api/me/orders/${unpaid.orderRef}/cancel`, null);
    assert.equal(res.statusCode, 401);
    res = await post(app, `/api/me/orders/${unpaid.orderRef}/cancel`, owner.session, null);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "csrf_invalid");
    res = await post(app, `/api/me/orders/${foreign.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 404);
    res = await post(app, "/api/me/orders/MISSING/cancel", owner.session);
    assert.equal(res.statusCode, 404);
    // 已付款订单不可按未付款取消。
    res = await post(app, `/api/me/orders/${paid.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "not_cancellable");
    // WAIT_BUYER_PAY → trade.close → 权威复查 TRADE_CLOSED → 原子关闭。
    res = await post(app, `/api/me/orders/${unpaid.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { result: "CANCELLED" });
    assert.equal(sdk.closeCalls.length, 1);
    assert.equal(sdk.closeCalls[0], `out-${unpaid.orderRef}`);
    const orderRow = database.prepare("SELECT status FROM orders WHERE id=?").all(unpaid.orderId)[0] as { status: string };
    const paymentRow = database.prepare("SELECT status FROM payments WHERE order_id=?").all(unpaid.orderId)[0] as { status: string };
    assert.equal(orderRow.status, "closed");
    assert.equal(paymentRow.status, "closed");
    const closure = database
      .prepare("SELECT closed_by_user_id, inventory_released, coupon_released FROM wallet_order_closures WHERE order_id=?")
      .all(unpaid.orderId)[0] as { closed_by_user_id: number; inventory_released: number; coupon_released: number };
    assert.equal(closure.closed_by_user_id, owner.id);
    assert.equal(closure.inventory_released, 1);
    assert.equal(closure.coupon_released, 1);
    res = await post(app, `/api/me/orders/${unpaid.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { result: "ALREADY_CANCELLED" });
    await app.close();
  });
});

test("buyer order cancel: provider failure announces nothing; late paid wins and is settled, never cancelled", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const app = walletApp(database, sdk);
    const owner = user(database, "c5@example.test");
    const pending = seedOrder(database, owner.id, { ref: "CANCEL-9", orderStatus: "pending", paymentStatus: "pending" });
    sdk.queryResponse = (ref: string) =>
      queryResult({ tradeStatus: "WAIT_BUYER_PAY", outTradeNo: ref, totalAmount: "79.00" });
    sdk.closeResponse = new Error("provider close unavailable");
    let res = await post(app, `/api/me/orders/${pending.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "wallet_unavailable");
    assert.equal(
      (database.prepare("SELECT status FROM orders WHERE id=?").all(pending.orderId)[0] as { status: string }).status,
      "pending",
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures").all()[0] && (database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures").all()[0] as { n: number }).n, 0);
    // 15 秒 provider 节流与状态查询共享：窗口内重试直接 unknown/503，不再访问 provider。
    const queriesBefore = sdk.queryCalls.length;
    res = await post(app, `/api/me/orders/${pending.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "wallet_unavailable");
    assert.equal(sdk.queryCalls.length, queriesBefore);
    database.prepare("UPDATE payments SET last_queried_at = NULL WHERE id=?").run(pending.paymentId);
    // 关单后复查发现买家已支付：paid 胜出，结算保留财务事实，取消被拒。
    sdk.closeResponse = { code: "10000" };
    sdk.queryResponse = (ref: string) =>
      queryResult({
        tradeStatus: sdk.closeCalls.includes(ref) ? "TRADE_SUCCESS" : "WAIT_BUYER_PAY",
        outTradeNo: ref,
        totalAmount: "79.00",
      });
    res = await post(app, `/api/me/orders/${pending.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "not_cancellable");
    assert.equal(
      (database.prepare("SELECT status FROM orders WHERE id=?").all(pending.orderId)[0] as { status: string }).status,
      "paid",
    );
    const settlement = database
      .prepare("SELECT state, provider_trade_no FROM wallet_order_settlements WHERE order_id=?")
      .all(pending.orderId)[0] as { state: string; provider_trade_no: string } | undefined;
    assert.equal(settlement?.state, "PAID");
    assert.equal(database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures").all()[0] && (database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures").all()[0] as { n: number }).n, 0);
    await app.close();
  });
});

test("admin order close: unpaid closes through provider path; paid+pending_open and OPEN record refund/termination; replay idempotent", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const app = walletApp(database, sdk);
    const owner = user(database, "a1@example.test");
    const admin = user(database, "a2@example.test", "admin");
    const nonAdmin = user(database, "a3@example.test");
    const unpaid = seedOrder(database, owner.id, { ref: "AC-1", orderStatus: "pending", paymentStatus: "pending" });
    const pendingOpen = seedOrder(database, owner.id, {
      ref: "AC-2", orderStatus: "paid", paymentStatus: "paid", tradeNo: "t-po", serviceStatus: "pending_open",
    });
    const open = seedOrder(database, owner.id, {
      ref: "AC-3", orderStatus: "paid", paymentStatus: "paid", tradeNo: "t-op", serviceStatus: "open", adminId: admin.id,
    });
    const noService = seedOrder(database, owner.id, { ref: "AC-4", orderStatus: "paid", paymentStatus: "paid", tradeNo: "t-ns" });
    database
      .prepare(`INSERT INTO wallet_consents(service_id,user_id,state,revision,next_billing_period,updated_at)
        VALUES (?,?,'ENABLED',1,'MONTHLY',?)`)
      .run(open.serviceId, owner.id, NOW);
    sdk.queryResponse = (ref: string) =>
      queryResult({
        tradeStatus: sdk.closeCalls.includes(ref) ? "TRADE_CLOSED" : "WAIT_BUYER_PAY",
        outTradeNo: ref,
        totalAmount: "79.00",
      });
    let res = await post(app, `/api/admin/orders/${unpaid.orderId}/close`, nonAdmin.session);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "forbidden");
    res = await post(app, `/api/admin/orders/${unpaid.orderId}/close`, admin.session, null);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "csrf_invalid");
    res = await post(app, "/api/admin/orders/999/close", admin.session);
    assert.equal(res.statusCode, 404);
    res = await post(app, `/api/admin/orders/${unpaid.orderId}/close`, admin.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      orderRef: "AC-1", managementClosed: true, refundState: null, serviceStopState: null,
    });
    assert.equal(
      (database.prepare("SELECT status FROM orders WHERE id=?").all(unpaid.orderId)[0] as { status: string }).status,
      "closed",
    );
    res = await post(app, `/api/admin/orders/${unpaid.orderId}/close`, admin.session);
    assert.deepEqual(res.json(), {
      orderRef: "AC-1", managementClosed: true, refundState: null, serviceStopState: null,
    });
    // paid + pending_open：管理关闭 + AWAITING_POLICY 退款案，支付事实原样保留。
    res = await post(app, `/api/admin/orders/${pendingOpen.orderId}/close`, admin.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      orderRef: "AC-2", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: null,
    });
    assert.equal(
      (database.prepare("SELECT status FROM payments WHERE order_id=?").all(pendingOpen.orderId)[0] as { status: string }).status,
      "paid",
    );
    assert.equal(
      (database.prepare("SELECT state FROM wallet_order_settlements WHERE order_id=?").all(pendingOpen.orderId)[0] as { state: string }).state,
      "PAID",
    );
    const refundRow = database
      .prepare("SELECT service_id, refund_state FROM wallet_refund_cases WHERE source_kind='ORIGINAL_PAYMENT' AND source_id=?")
      .all(pendingOpen.paymentId)[0] as { service_id: number; refund_state: string };
    assert.equal(refundRow.refund_state, "AWAITING_POLICY");
    assert.equal(refundRow.service_id, pendingOpen.serviceId);
    res = await post(app, `/api/admin/orders/${pendingOpen.orderId}/close`, admin.session);
    assert.deepEqual(res.json(), {
      orderRef: "AC-2", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: null,
    });
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM wallet_refund_cases WHERE source_kind='ORIGINAL_PAYMENT' AND source_id=?").all(pendingOpen.paymentId)[0] as { n: number }).n,
      1,
    );
    // OPEN 服务：REQUESTED 内部终止 + 自动续期禁用，无外部停止。
    res = await post(app, `/api/admin/orders/${open.orderId}/close`, admin.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      orderRef: "AC-3", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: "REQUESTED",
    });
    const termination = database
      .prepare("SELECT stop_state, requested_by FROM wallet_termination_cases WHERE service_id=?")
      .all(open.serviceId)[0] as { stop_state: string; requested_by: number };
    assert.equal(termination.stop_state, "REQUESTED");
    assert.equal(termination.requested_by, admin.id);
    assert.equal(
      (database.prepare("SELECT state FROM wallet_consents WHERE service_id=?").all(open.serviceId)[0] as { state: string }).state,
      "DISABLED",
    );
    res = await post(app, `/api/admin/orders/${open.orderId}/close`, admin.session);
    assert.deepEqual(res.json(), {
      orderRef: "AC-3", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: "REQUESTED",
    });
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM wallet_refund_cases WHERE source_kind='ORIGINAL_PAYMENT' AND source_id=?").all(open.paymentId)[0] as { n: number }).n,
      1,
    );
    // 已付款但无 services 行：管理关闭 + NULL service_id 退款案（绑定已验证支付），
    // 绝不伪造 services/OPEN 行；无属主 guest 支付单仍拒绝。
    res = await post(app, `/api/admin/orders/${noService.orderId}/close`, admin.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      orderRef: "AC-4", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: null,
    });
    const servicelessCase = database
      .prepare("SELECT service_id, refund_state FROM wallet_refund_cases WHERE source_kind='ORIGINAL_PAYMENT' AND source_id=?")
      .all(noService.paymentId)[0] as { service_id: number | null; refund_state: string };
    assert.equal(servicelessCase.service_id, null);
    assert.equal(servicelessCase.refund_state, "AWAITING_POLICY");
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures WHERE order_id=?").all(noService.orderId)[0] as { n: number }).n,
      1,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM services WHERE payment_id=?").all(noService.paymentId)[0] as { n: number }).n,
      0,
    );
    const guest = seedOrder(database, owner.id, { ref: "AC-5", orderStatus: "paid", paymentStatus: "paid", tradeNo: "t-g" });
    database.prepare("UPDATE orders SET user_id=NULL WHERE id=?").run(guest.orderId);
    res = await post(app, `/api/admin/orders/${guest.orderId}/close`, admin.session);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "not_cancellable");
    // 管理关闭后的 OPEN 服务：OPEN+paid 旧检查仍会通过，但每个可执行的续期
    // 面都必须命中真实关闭态——报价/启用/改期一律 409 service_closed，仅 OFF 放行。
    res = await get(app, `/api/me/services/${open.serviceId}/renewal-quote?period=MONTHLY`, owner.session);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "service_closed");
    res = await get(app, `/api/me/services/${open.serviceId}/renewal-quote?period=MONTHLY`, nonAdmin.session);
    assert.equal(res.statusCode, 404);
    const closedConsent = database
      .prepare("SELECT revision,state FROM wallet_consents WHERE service_id=?").all(open.serviceId)[0] as { revision: number; state: string };
    assert.equal(closedConsent.state, "DISABLED");
    res = await put(app, `/api/me/services/${open.serviceId}/renewal-consent`, owner.session, {
      period: "MONTHLY", expectedRevision: closedConsent.revision, enabled: true, expectedQuoteKey: "k",
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "service_closed");
    res = await put(app, `/api/me/services/${open.serviceId}/renewal-consent`, owner.session, {
      period: "MONTHLY", expectedRevision: closedConsent.revision, enabled: false,
    });
    assert.equal(res.statusCode, 200);
    res = await get(app, `/api/me/services/${open.serviceId}/renewal-consent`, owner.session);
    assert.equal(res.statusCode, 200);
    assert.equal((res.json() as { consent: { state: string } }).consent.state, "DISABLED");
    res = await put(app, `/api/me/services/${open.serviceId}/next-billing-period`, owner.session, {
      period: "SEMIANNUAL", expectedRevision: closedConsent.revision + 1,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "service_closed");
    res = await put(app, `/api/admin/services/${open.serviceId}/next-billing-period`, admin.session, {
      period: "SEMIANNUAL", expectedRevision: closedConsent.revision + 1,
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "service_closed");
    await app.close();
  });
});

test("close-first late paid: wallet preserves the verified payment as PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING with a bound refund case", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const app = walletApp(database, sdk);
    const owner = user(database, "l1@example.test");
    const admin = user(database, "l2@example.test", "admin");
    const unpaid = seedOrder(database, owner.id, { ref: "LATE-1", orderStatus: "pending", paymentStatus: "pending" });
    sdk.queryResponse = (ref: string) =>
      queryResult({
        tradeStatus: sdk.closeCalls.includes(ref) ? "TRADE_CLOSED" : "WAIT_BUYER_PAY",
        outTradeNo: ref,
        tradeNo: "late-trade-1",
        totalAmount: "79.00",
      });
    let res = await post(app, `/api/me/orders/${unpaid.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { result: "CANCELLED" });
    // 先关后到的合法支付（权威事件）：paid 事实恢复，结算标记待退款，绝不重开交付。
    const result = applyAdminOrderClose(
      database,
      { database, appId: "app-123", sellerId: "seller-456" },
      { userId: admin.id, sessionValid: true, csrfValid: true, isAdmin: true },
      unpaid.orderId,
      {
        kind: "paid",
        event: {
          outTradeNo: `out-${unpaid.orderRef}`,
          tradeNo: "late-trade-1",
          tradeStatus: "TRADE_SUCCESS",
          totalAmount: "79.00",
          totalAmountFen: 7900,
          appId: "app-123",
          sellerId: "seller-456",
        },
      },
      NOW,
    );
    assert.equal(result.managementClosed, true);
    assert.equal(result.refundState, "AWAITING_POLICY");
    assert.equal(
      (database.prepare("SELECT status FROM orders WHERE id=?").all(unpaid.orderId)[0] as { status: string }).status,
      "paid",
    );
    assert.equal(
      (database.prepare("SELECT state FROM wallet_order_settlements WHERE order_id=?").all(unpaid.orderId)[0] as { state: string }).state,
      "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING",
    );
    const serviceId = (database.prepare("SELECT s.id FROM services s JOIN payments p ON p.id=s.payment_id WHERE p.order_id=?").all(unpaid.orderId)[0] as { id: number }).id;
    const refund = database
      .prepare("SELECT service_id, refund_state FROM wallet_refund_cases WHERE source_kind='ORIGINAL_PAYMENT' AND source_id=?")
      .all(unpaid.paymentId)[0] as { service_id: number; refund_state: string };
    assert.equal(refund.service_id, serviceId);
    assert.equal(refund.refund_state, "AWAITING_POLICY");
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures WHERE order_id=?").all(unpaid.orderId)[0] as { n: number }).n,
      1,
    );
    // 变体：provider 从未见过该交易（ACQ.TRADE_NOT_EXIST）→ 合成 LOCAL-CANCEL
    // 标记关单；之后到达的真实签名 SUCCESS 仍以真实 trade_no 替换标记并结清。
    const ghost = seedOrder(database, owner.id, { ref: "LATE-2", orderStatus: "pending", paymentStatus: "pending" });
    sdk.queryResponse = () => tradeNotExistResult();
    res = await post(app, `/api/me/orders/${ghost.orderRef}/cancel`, owner.session);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { result: "CANCELLED" });
    assert.equal(
      (database.prepare("SELECT trade_no FROM payments WHERE id=?").all(ghost.paymentId)[0] as { trade_no: string }).trade_no,
      `LOCAL-CANCEL-out-${ghost.orderRef}`,
    );
    const ghostResult = applyAdminOrderClose(
      database,
      { database, appId: "app-123", sellerId: "seller-456" },
      { userId: admin.id, sessionValid: true, csrfValid: true, isAdmin: true },
      ghost.orderId,
      {
        kind: "paid",
        event: {
          outTradeNo: `out-${ghost.orderRef}`,
          tradeNo: "real-late-trade",
          tradeStatus: "TRADE_SUCCESS",
          totalAmount: "79.00",
          totalAmountFen: 7900,
          appId: "app-123",
          sellerId: "seller-456",
        },
      },
      NOW,
    );
    assert.equal(ghostResult.managementClosed, true);
    assert.equal(
      (database.prepare("SELECT trade_no FROM payments WHERE id=?").all(ghost.paymentId)[0] as { trade_no: string }).trade_no,
      "real-late-trade",
    );
    assert.equal(
      (database.prepare("SELECT state FROM wallet_order_settlements WHERE order_id=?").all(ghost.orderId)[0] as { state: string }).state,
      "PAID_AFTER_LOCAL_CLOSE_REFUND_PENDING",
    );
    // 买家侧同样的先关后付：闭单记录与新支付/退款案必须原子并存，绝不丢关闭态。
    const buyerClosed = applyBuyerOrderCancellation(
      database,
      { database, appId: "app-123", sellerId: "seller-456" },
      { userId: owner.id, sessionValid: true, csrfValid: true, isAdmin: false },
      ghost.orderRef,
      {
        kind: "paid",
        event: {
          outTradeNo: `out-${ghost.orderRef}`,
          tradeNo: "real-late-trade",
          tradeStatus: "TRADE_SUCCESS",
          totalAmount: "79.00",
          totalAmountFen: 7900,
          appId: "app-123",
          sellerId: "seller-456",
        },
      },
      NOW,
    );
    assert.equal(buyerClosed, "ALREADY_CANCELLED");
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM wallet_order_closures WHERE order_id=?").all(ghost.orderId)[0] as { n: number }).n,
      1,
    );
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS n FROM wallet_refund_cases WHERE source_kind='ORIGINAL_PAYMENT' AND source_id=?").all(ghost.paymentId)[0] as { n: number }).n,
      1,
    );
    await app.close();
  });
});

test("next-billing-period: owner PUT validates current SKU quote, forces RECONSENT_REQUIRED, keeps DISABLED off", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = walletApp(database);
    const owner = user(database, "p1@example.test");
    const admin = user(database, "p2@example.test", "admin");
    const foreign = user(database, "p3@example.test");
    const serviceId = seedService(database, owner.id, admin.id);
    const url = `/api/me/services/${serviceId}/next-billing-period`;
    let res = await put(app, url, owner.session, { period: "SEMIANNUAL", expectedRevision: 0 }, null);
    assert.equal(res.statusCode, 403);
    res = await put(app, url, foreign.session, { period: "SEMIANNUAL", expectedRevision: 0 });
    assert.equal(res.statusCode, 404);
    res = await put(app, url, owner.session, { period: "SEMIANNUAL", expectedRevision: 0, priceFen: 1 });
    assert.equal(res.statusCode, 400);
    // 无 consent 行：期望修订 0 建立 DISABLED 行并暂存周期。
    res = await put(app, url, owner.session, { period: "SEMIANNUAL", expectedRevision: 0 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { revision: 1 });
    let consent = database.prepare("SELECT state,revision,next_billing_period FROM wallet_consents WHERE service_id=?").all(serviceId)[0] as { state: string; revision: number; next_billing_period: string };
    assert.equal(consent.state, "DISABLED");
    assert.equal(consent.next_billing_period, "SEMIANNUAL");
    // QUARTERLY 对应 month-3 无在售 SKU → 409。
    res = await put(app, url, owner.session, { period: "QUARTERLY", expectedRevision: 1 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "quote_unavailable");
    res = await put(app, url, owner.session, { period: "MONTHLY", expectedRevision: 9 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "revision_conflict");
    res = await put(app, url, owner.session, { period: "ANNUAL", expectedRevision: 1 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { revision: 2 });
    consent = database.prepare("SELECT state,next_billing_period FROM wallet_consents WHERE service_id=?").all(serviceId)[0] as { state: string; revision: number; next_billing_period: string };
    assert.equal(consent.state, "DISABLED");
    assert.equal(consent.next_billing_period, "ANNUAL");
    // ENABLED 行再改周期 → RECONSENT_REQUIRED。
    const enableKey = (await get(app, `/api/me/services/${serviceId}/renewal-quote?period=MONTHLY`, owner.session)).json().quote.key as string;
    res = await put(app, `/api/me/services/${serviceId}/renewal-consent`, owner.session, {
      period: "MONTHLY", expectedRevision: 2, enabled: true, expectedQuoteKey: enableKey,
    });
    assert.equal(res.statusCode, 200);
    res = await put(app, url, owner.session, { period: "SEMIANNUAL", expectedRevision: 3 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { revision: 4 });
    consent = database.prepare("SELECT state,next_billing_period FROM wallet_consents WHERE service_id=?").all(serviceId)[0] as { state: string; revision: number; next_billing_period: string };
    assert.equal(consent.state, "RECONSENT_REQUIRED");
    assert.equal(consent.next_billing_period, "SEMIANNUAL");
    await app.close();
  });
});

test("admin next-billing-period: role gate 403, missing 404, quote check, owner consent row preserved", async () => {
  await withAuthenticationDatabase(async (database) => {
    // 支付关闭时 /api/admin/services/* 被全局 503 钩子拦截（既有语义），故须注入 fake SDK。
    const app = walletApp(database, new FakeAlipaySdk());
    const owner = user(database, "q1@example.test");
    const admin = user(database, "q2@example.test", "admin");
    const nonAdmin = user(database, "q3@example.test");
    const serviceId = seedService(database, owner.id, admin.id);
    const url = `/api/admin/services/${serviceId}/next-billing-period`;
    let res = await put(app, url, nonAdmin.session, { period: "SEMIANNUAL", expectedRevision: 0 });
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "forbidden");
    res = await put(app, "/api/admin/services/999/next-billing-period", admin.session, { period: "SEMIANNUAL", expectedRevision: 0 });
    assert.equal(res.statusCode, 404);
    res = await put(app, url, admin.session, { period: "QUARTERLY", expectedRevision: 0 });
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "quote_unavailable");
    res = await put(app, url, admin.session, { period: "SEMIANNUAL", expectedRevision: 0 });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { revision: 1 });
    const consent = database.prepare("SELECT user_id,state,next_billing_period FROM wallet_consents WHERE service_id=?").all(serviceId)[0] as { user_id: number; state: string; next_billing_period: string };
    assert.equal(consent.user_id, owner.id);
    assert.equal(consent.state, "DISABLED");
    assert.equal(consent.next_billing_period, "SEMIANNUAL");
    await app.close();
  });
});

test("admin orders list: role gates, stored-state DTO, filters, cursor pagination, close state refresh", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = walletApp(database);
    const owner = user(database, "ao1@example.test");
    const other = user(database, "ao2@example.test");
    const admin = user(database, "ao3@example.test", "admin");
    const pending = seedOrder(database, owner.id, { ref: "AL-PEND", orderStatus: "pending", paymentStatus: "pending" });
    const paidOpen = seedOrder(database, owner.id, { ref: "AL-OPEN", orderStatus: "paid", paymentStatus: "paid", serviceStatus: "open", adminId: admin.id, tradeNo: "al-open-t" });
    const paidNoService = seedOrder(database, other.id, { ref: "AL-NOSVC", orderStatus: "paid", paymentStatus: "paid", tradeNo: "al-nosvc-t" });
    // 无 payments 行的订单（历史/异常形状）也必须列出：paymentStatus 为 null，绝不推断。
    database.prepare(
      `INSERT INTO orders (order_ref, idempotency_key, request_fingerprint, user_id,
        type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
        amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at)
       VALUES ('AL-NOPAY','i-AL-NOPAY','f-AL-NOPAY',NULL,'local-isp','us','us-verizon',NULL,'month-1','SUBSCRIBE-CATALOG-V1',
        7900,'CNY','w@example.test','[]',NULL,'paid',?,?)`,
    ).run(NOW, NOW);
    const noPayment = database.prepare("SELECT id FROM orders WHERE order_ref='AL-NOPAY'").all()[0] as { id: number };

    let res = await get(app, "/api/admin/orders", null);
    assert.equal(res.statusCode, 401);
    res = await get(app, "/api/admin/orders", owner.session);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error.code, "forbidden");
    // 严格过滤器：未知键 / 非法值一律 400，绝不静默忽略。
    res = await get(app, "/api/admin/orders?tradeNo=x", admin.session);
    assert.equal(res.statusCode, 400);
    res = await get(app, "/api/admin/orders?userId=-1", admin.session);
    assert.equal(res.statusCode, 400);
    res = await get(app, "/api/admin/orders?beforeId=abc", admin.session);
    assert.equal(res.statusCode, 400);
    res = await get(app, "/api/admin/orders?orderRef=", admin.session);
    assert.equal(res.statusCode, 400);

    res = await get(app, "/api/admin/orders", admin.session);
    assert.equal(res.statusCode, 200);
    const byRef = new Map(res.json().orders.map((o: { orderRef: string }) => [o.orderRef, o]));
    const pendRow = byRef.get(pending.orderRef) as Record<string, unknown>;
    assert.deepEqual(
      Object.keys(pendRow).sort(),
      ["amountFen", "createdAt", "currency", "id", "managementClosed", "orderRef", "paymentStatus",
        "refundState", "serviceId", "serviceStatus", "serviceStopState", "status", "userId"].sort(),
    );
    assert.equal(pendRow.status, "pending");
    assert.equal(pendRow.paymentStatus, "pending");
    assert.equal(pendRow.serviceId, null);
    assert.equal(pendRow.serviceStatus, null);
    assert.equal(pendRow.managementClosed, false);
    assert.equal(pendRow.refundState, null);
    assert.equal(pendRow.serviceStopState, null);
    assert.equal(pendRow.userId, owner.id);
    const openRow = byRef.get(paidOpen.orderRef) as Record<string, unknown>;
    assert.equal(openRow.status, "paid");
    assert.equal(openRow.paymentStatus, "paid");
    assert.equal(openRow.serviceId, paidOpen.serviceId);
    assert.equal(openRow.serviceStatus, "open");
    const noSvcRow = byRef.get(paidNoService.orderRef) as Record<string, unknown>;
    assert.equal(noSvcRow.paymentStatus, "paid");
    assert.equal(noSvcRow.serviceId, null);
    const noPayRow = byRef.get("AL-NOPAY") as Record<string, unknown>;
    assert.equal(noPayRow.status, "paid");
    assert.equal(noPayRow.paymentStatus, null);
    assert.equal(noPayRow.userId, null);
    assert.equal(noPayRow.amountFen, 7900);
    assert.equal(noPayRow.currency, "CNY");

    // 精确过滤器。
    res = await get(app, `/api/admin/orders?orderRef=${paidOpen.orderRef}`, admin.session);
    assert.equal(res.json().orders.length, 1);
    assert.equal(res.json().orders[0].id, paidOpen.orderId);
    res = await get(app, `/api/admin/orders?userId=${other.id}`, admin.session);
    assert.equal(res.json().orders.length, 1);
    assert.equal(res.json().orders[0].orderRef, paidNoService.orderRef);
    res = await get(app, `/api/admin/orders?orderRef=${paidOpen.orderRef}&userId=${other.id}`, admin.session);
    assert.equal(res.json().orders.length, 0);
    res = await get(app, `/api/admin/orders?beforeId=${paidOpen.orderId}`, admin.session);
    assert.equal(res.json().orders.length, 1);
    assert.equal(res.json().orders[0].orderRef, pending.orderRef);

    // 分页：55 个真实订单 → 首页 50 + 游标，次页余量 + null，无重复无遗漏。
    for (let i = 0; i < 55; i += 1) {
      database.prepare(
        `INSERT INTO orders (order_ref, idempotency_key, request_fingerprint, user_id,
          type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
          amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at)
         VALUES (?,?,?,?, 'local-isp','us','us-verizon',NULL,'month-1','SUBSCRIBE-CATALOG-V1',
          100,'CNY','w@example.test','[]',NULL,'pending',?,?)`,
      ).run(`AL-BULK-${i}`, `i-AL-BULK-${i}`, `f-AL-BULK-${i}`, owner.id, NOW, NOW);
    }
    const total = (database.prepare("SELECT COUNT(*) AS n FROM orders").all()[0] as { n: number }).n;
    res = await get(app, "/api/admin/orders", admin.session);
    assert.equal(res.json().orders.length, 50);
    const next = res.json().nextBeforeId as number | null;
    assert.equal(typeof next, "number");
    res = await get(app, `/api/admin/orders?beforeId=${next}`, admin.session);
    assert.equal(res.json().nextBeforeId, null);
    assert.equal(res.json().orders.length, total - 50);
    const seen = new Set<number>();
    const all = await get(app, "/api/admin/orders", admin.session);
    for (const o of all.json().orders as Array<{ id: number }>) seen.add(o.id);
    for (const o of res.json().orders as Array<{ id: number }>) seen.add(o.id);
    assert.equal(seen.size, total);

    // 状态实时读取：关单后同一列表立即反映管理关闭 + 真实退款案。
    const closed = applyAdminOrderClose(
      database,
      { database, appId: "app-123", sellerId: "seller-456" },
      { userId: admin.id, sessionValid: true, csrfValid: true, isAdmin: true },
      paidNoService.orderId, null, NOW,
    );
    assert.equal(closed.managementClosed, true);
    assert.equal(closed.refundState, "AWAITING_POLICY");
    assert.equal(closed.serviceStopState, null);
    res = await get(app, `/api/admin/orders?orderRef=${paidNoService.orderRef}`, admin.session);
    const row = res.json().orders[0];
    assert.equal(row.managementClosed, true);
    assert.equal(row.refundState, "AWAITING_POLICY");
    assert.equal(row.serviceStopState, null);
    assert.equal(row.paymentStatus, "paid");
    await app.close();
  });
});

test("admin orders list fails closed with 503 when a required wallet table is missing", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = walletApp(database);
    const admin = user(database, "ao4@example.test", "admin");
    seedOrder(database, admin.id, { ref: "AL-503" });
    let res = await get(app, "/api/admin/orders", admin.session);
    assert.equal(res.statusCode, 200);
    // 026 钱包表缺失/读取失败是运行时故障：必须 503，绝不 200 空集或假标志。
    database.exec("DROP TABLE wallet_termination_cases");
    res = await get(app, "/api/admin/orders", admin.session);
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "wallet_unavailable");
    await app.close();
  });
});
