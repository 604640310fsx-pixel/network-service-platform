import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { issueCsrfToken } from "../../src/http/csrf.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizeClosed, finalizePaid } from "../../src/payment/state-machine.js";
import { computeSessionTokenHash } from "../../src/session/session-token.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  ACCESS_TOKEN_C,
  FakeAlipaySdk,
  TOKEN_KEYRING,
  allRows,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

test("create-order API stores only the client credential hash and returns the frozen website-pay result", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const app = buildApp({ payment: dependencies });
    const buyerId = insertAuthenticationUser(database, {
      email: "buyer@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const buyerSession = insertWebSession(database, buyerId);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          cookie: buyerSession.cookie,
          "content-type": "application/json",
          "idempotency-key": "browser-key-1",
          "x-order-access-token": ACCESS_TOKEN_A,
        },
        payload: {
          ...localIspSelection(),
          contact: "wechat-user",
          scenarios: ["TikTok / 社媒"],
          notes: "manual delivery",
          acknowledgedAmountFen: 7_900,
        },
      });
      assert.equal(response.statusCode, 200);
      const body = response.json();
      assert.deepEqual(Object.keys(body).sort(), [
        "amountFen",
        "currency",
        "orderRef",
        "payUrl",
        "reservedUntil",
        "status",
      ]);
      assert.equal(body.status, "pending");
      assert.equal(body.amountFen, 7_900);
      assert.equal(body.currency, "CNY");
      assert.equal(body.reservedUntil, "2026-08-21T00:30:00.000Z");
      assert.equal(body.payUrl, `https://alipay.example.test/pay/${body.orderRef}`);
      assert.equal(response.body.includes(ACCESS_TOKEN_A), false);
      assert.equal(
        firstValue(
          database,
          "SELECT COUNT(*) FROM order_access_tokens WHERE token_hash = ?",
          ACCESS_TOKEN_A,
        ),
        0,
      );
      assert.equal(firstValue(database, "SELECT token_key_version FROM order_access_tokens"), 1);
      assert.equal(firstValue(database, "SELECT user_id FROM orders"), buyerId);
      assert.equal(sdk.pageCalls.length, 1);
    } finally {
      await app.close();
    }
  });
});

test("server pricing rejects changed and over-limit amounts before any SDK pageExecute call", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const app = buildApp({ payment: dependencies });
    const buyerSession = insertWebSession(
      database,
      insertAuthenticationUser(database, {
        email: "pricing-buyer@example.com",
        passwordHash: "hash",
        status: "active",
      }),
    );
    try {
      const changed = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          cookie: buyerSession.cookie,
          "content-type": "application/json",
          "idempotency-key": "price-change-key",
          "x-order-access-token": ACCESS_TOKEN_A,
        },
        payload: {
          ...localIspSelection(),
          contact: "contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 1,
        },
      });
      assert.equal(changed.statusCode, 409);
      assert.deepEqual(changed.json(), {
        error: { code: "price_changed", currentAmountFen: 7_900 },
      });

      const overLimit = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          cookie: buyerSession.cookie,
          "content-type": "application/json",
          "idempotency-key": "over-limit-key",
          "x-order-access-token": ACCESS_TOKEN_B,
        },
        payload: {
          typeId: "residential",
          regionId: "us",
          ispId: "comcast",
          specId: "dedicated",
          durationId: "month-12",
          contact: "contact",
          scenarios: [],
          notes: null,
          acknowledgedAmountFen: 632_600,
        },
      });
      // Migration 012 seeds every combination priced above the single-payment
      // cap as is_active=0 (residential/us/comcast/dedicated/month-12 is one
      // of the frozen 29), so plan_unavailable now fires before the amount
      // check ever runs — this is the correct, spec-mandated outcome, not a
      // regression of the amount guard itself (see the commerce.test.ts
      // "actively priced above the cap" case for that guard in isolation).
      assert.equal(overLimit.statusCode, 409);
      assert.deepEqual(overLimit.json(), {
        error: { code: "plan_unavailable" },
      });
      assert.equal(sdk.pageCalls.length, 0);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 0);
    } finally {
      await app.close();
    }
  });
});

test("create-order API requires a web session, binds the server user, and keeps legacy guest orders payable", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const legacyGuest = createPaymentOrder(dependencies, {
      idempotencyKey: "legacy-guest-key",
      rawAccessToken: ACCESS_TOKEN_C,
      selection: localIspSelection(),
      contact: "legacy-guest",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: null,
    });
    const buyerId = insertAuthenticationUser(database, {
      email: "session-buyer@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const otherId = insertAuthenticationUser(database, {
      email: "someone-else@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const buyerSession = insertWebSession(database, buyerId);
    const app = buildApp({ payment: dependencies });
    const payload = {
      ...localIspSelection(),
      contact: "session-contact",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
    };
    try {
      for (const cookie of [undefined, "__Host-web_session=not-a-real-session-token"]) {
        const rejected = await app.inject({
          method: "POST",
          url: "/api/pay/orders",
          headers: {
            ...(cookie === undefined ? {} : { cookie }),
            "content-type": "application/json",
            "idempotency-key": "anonymous-key",
            "x-order-access-token": ACCESS_TOKEN_A,
          },
          payload,
        });
        assert.equal(rejected.statusCode, 401);
        assert.deepEqual(rejected.json(), { error: { code: "unauthorized" } });
      }
      // Unauthenticated requests are rejected before validation, even when malformed.
      const malformed = await app.inject({ method: "POST", url: "/api/pay/orders", payload: {} });
      assert.equal(malformed.statusCode, 401);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
      assert.equal(sdk.pageCalls.length, 0);

      const created = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
          cookie: buyerSession.cookie,
          "content-type": "application/json",
          "idempotency-key": "session-key",
          "x-order-access-token": ACCESS_TOKEN_A,
        },
        // A client-supplied owner is ignored; ownership comes only from the session.
        payload: { ...payload, userId: otherId },
      });
      assert.equal(created.statusCode, 200);
      assert.equal(
        firstValue(database, "SELECT user_id FROM orders WHERE order_ref = ?", created.json().orderRef),
        buyerId,
      );

      // A pre-change guest order stays readable and payable with its browser credential alone.
      const legacyStatus = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${legacyGuest.orderRef}`,
        headers: { "x-order-access-token": ACCESS_TOKEN_C },
      });
      assert.equal(legacyStatus.statusCode, 200);
      assert.equal(legacyStatus.json().status, "pending");
      const legacyPayPage = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${legacyGuest.orderRef}/pay-page`,
        headers: { "x-order-access-token": ACCESS_TOKEN_C },
      });
      assert.equal(legacyPayPage.statusCode, 200);
      assert.equal(
        legacyPayPage.json().payUrl,
        `https://alipay.example.test/pay/${legacyGuest.orderRef}`,
      );
      assert.equal(firstValue(database, "SELECT user_id FROM orders WHERE order_ref = ?", legacyGuest.orderRef), null);
    } finally {
      await app.close();
    }
  });
});

test("retry API authenticates the old order, copies its snapshot, and stores the new raw token only as a hash", async () => {
  await withAuthenticationDatabase(async (database) => {
    let sequence = 0;
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk, () => {
      sequence += 1;
      return `${sequence.toString().padStart(8, "0")}-2222-4222-8222-222222222222`;
    });
    const old = createPaymentOrder(dependencies, {
      idempotencyKey: "old-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "old-contact",
      scenarios: ["AI 工具", "TikTok / 社媒"],
      notes: "old-notes",
      acknowledgedAmountFen: 7_900,
      userId: null,
    });
    finalizeClosed(dependencies, {
      outTradeNo: old.orderRef,
      tradeNo: "trade-old",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "notify-close", payloadHash: "close-hash" },
    });
    const app = buildApp({ payment: dependencies });
    const buyerId = insertAuthenticationUser(database, {
      email: "retry-http-buyer@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const buyerSession = insertWebSession(database, buyerId);
    try {
      // Retry creates a new order, so an anonymous caller is rejected even with the valid old token.
      const anonymous = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${old.orderRef}/retry`,
        headers: {
          "idempotency-key": "retry-key",
          "x-order-access-token": ACCESS_TOKEN_A,
          "x-new-order-access-token": ACCESS_TOKEN_B,
        },
      });
      assert.equal(anonymous.statusCode, 401);
      assert.deepEqual(anonymous.json(), { error: { code: "unauthorized" } });
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);

      const unauthorized = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${old.orderRef}/retry`,
        headers: {
          cookie: buyerSession.cookie,
          "idempotency-key": "retry-key",
          "x-order-access-token": ACCESS_TOKEN_C,
          "x-new-order-access-token": ACCESS_TOKEN_B,
        },
      });
      assert.equal(unauthorized.statusCode, 404);

      const retried = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${old.orderRef}/retry`,
        headers: {
          cookie: buyerSession.cookie,
          "idempotency-key": "retry-key",
          "x-order-access-token": ACCESS_TOKEN_A,
          "x-new-order-access-token": ACCESS_TOKEN_B,
        },
      });
      assert.equal(retried.statusCode, 200);
      assert.deepEqual(Object.keys(retried.json()).sort(), [
        "amountFen",
        "currency",
        "orderRef",
        "payUrl",
        "reservedUntil",
        "status",
      ]);
      const retriedBody = retried.json();
      assert.notEqual(retriedBody.orderRef, old.orderRef);
      assert.equal(retriedBody.status, "pending");
      assert.equal(retriedBody.amountFen, 7_900);
      assert.equal(retriedBody.currency, "CNY");
      assert.equal(retriedBody.reservedUntil, "2026-08-21T00:30:00.000Z");
      assert.equal(
        retriedBody.payUrl,
        `https://alipay.example.test/pay/${retriedBody.orderRef}`,
      );
      assert.equal(retried.body.includes(ACCESS_TOKEN_B), false);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 2);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM order_access_tokens"), 2);
      assert.equal(firstValue(database, "SELECT user_id FROM orders WHERE order_ref = ?", retriedBody.orderRef), buyerId);
      assert.equal(firstValue(database, "SELECT user_id FROM orders WHERE order_ref = ?", old.orderRef), null);
      assert.equal(sdk.pageCalls.length, 1);
    } finally {
      await app.close();
    }
  });
});

test("me/services derives ownership only through services to payments to orders", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "customer@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const otherId = insertAuthenticationUser(database, {
      email: "other@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const userSession = insertWebSession(database, userId);
    const otherSession = insertWebSession(database, otherId);
    const dependencies = paymentDependencies(database);
    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "owned-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "customer-contact",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId,
    });
    finalizePaid(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-owned",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "notify-owned", payloadHash: "owned-hash" },
    });
    const app = buildApp({ payment: dependencies });
    try {
      const mine = await app.inject({
        method: "GET",
        url: "/api/me/services",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(mine.statusCode, 200);
      assert.equal(mine.json().items.length, 1);
      assert.equal(mine.json().items[0].orderRef, order.orderRef);

      const others = await app.inject({
        method: "GET",
        url: "/api/me/services",
        headers: { cookie: otherSession.cookie },
      });
      assert.equal(others.statusCode, 200);
      assert.deepEqual(others.json(), { items: [] });

      const anonymous = await app.inject({ method: "GET", url: "/api/me/services" });
      assert.equal(anonymous.statusCode, 401);
    } finally {
      await app.close();
    }
  });
});

test("me/delivery-lines returns only buyer-visible labels for the owning user", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "line-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const otherId = insertAuthenticationUser(database, {
      email: "line-other@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "line-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const userSession = insertWebSession(database, userId);
    const otherSession = insertWebSession(database, otherId);
    const adminSession = insertWebSession(database, adminId);
    const dependencies = paymentDependencies(database);
    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "delivery-line-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "line-contact",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId,
    });
    finalizePaid(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-delivery-line",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "notify-delivery-line", payloadHash: "delivery-line-hash" },
    });
    const serviceId = firstValue(database, "SELECT id FROM services");
    assert.equal(typeof serviceId, "number");
    const app = buildApp({ payment: dependencies });
    try {
      const adminSessionHash = computeSessionTokenHash(
        adminSession.rawToken,
        TOKEN_KEYRING,
      ).tokenHash;
      const csrf = issueCsrfToken(dependencies.csrfSigningKey, adminSessionHash);
      const opened = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [
            {
              label: "日本中转 A",
              subscriptionUrl: "https://subscription.example.test/customer-line",
              monitorTargetKey: "Tokyo Transit A",
            },
          ],
        },
      });
      assert.equal(opened.statusCode, 200);

      const mine = await app.inject({
        method: "GET",
        url: "/api/me/delivery-lines",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(mine.statusCode, 200);
      assert.equal(mine.headers["cache-control"], "no-store");
      assert.deepEqual(mine.json(), {
        items: [{
          orderRef: order.orderRef,
          position: 1,
          label: "日本中转 A",
        }],
      });
      assert.equal(mine.body.includes("subscription.example.test"), false);
      assert.equal(mine.body.includes("monitorTargetKey"), false);
      assert.deepEqual(Object.keys(mine.json().items[0]).sort(), [
        "label",
        "orderRef",
        "position",
      ]);

      const others = await app.inject({
        method: "GET",
        url: "/api/me/delivery-lines",
        headers: { cookie: otherSession.cookie },
      });
      assert.equal(others.statusCode, 200);
      assert.deepEqual(others.json(), { items: [] });

      const anonymous = await app.inject({ method: "GET", url: "/api/me/delivery-lines" });
      assert.equal(anonymous.statusCode, 401);

      database
        .prepare("UPDATE service_delivery_items SET label = ? WHERE service_id = ?")
        .run(" 非规范线路名 ", serviceId);
      const corrupt = await app.inject({
        method: "GET",
        url: "/api/me/delivery-lines",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(corrupt.statusCode, 503);
      assert.deepEqual(corrupt.json(), { error: { code: "payment_unavailable" } });
    } finally {
      await app.close();
    }
  });
});

test("admin list returns the full frozen snapshot and open requires admin plus valid CSRF", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "customer2@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const userSession = insertWebSession(database, userId);
    const adminSession = insertWebSession(database, adminId);
    const dependencies = paymentDependencies(database);
    const order = createPaymentOrder(dependencies, {
      idempotencyKey: "admin-list-key",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "delivery-contact",
      scenarios: ["AI 工具", "TikTok / 社媒"],
      notes: "open manually",
      acknowledgedAmountFen: 7_900,
      userId,
    });
    finalizePaid(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-admin-list",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "notify-admin-list", payloadHash: "admin-list-hash" },
    });
    const serviceId = firstValue(database, "SELECT id FROM services");
    assert.equal(typeof serviceId, "number");
    const app = buildApp({ payment: dependencies });
    try {
      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/services?status=pending_open",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(forbidden.statusCode, 403);

      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/services?status=pending_open",
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(listed.statusCode, 200);
      assert.deepEqual(listed.json(), {
        items: [
          {
            serviceId,
            orderRef: order.orderRef,
            typeId: "local-isp",
            regionId: "us",
            ispId: "us-verizon",
            specId: null,
            durationId: "month-1",
            amountFen: 7_900,
            contact: "delivery-contact",
            scenarios: ["AI 工具", "TikTok / 社媒"],
            notes: "open manually",
            createdAt: "2026-08-21T00:00:00.000Z",
          },
        ],
      });

      const targetForbidden = await app.inject({
        method: "GET",
        url: "/api/admin/monitor-targets",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(targetForbidden.statusCode, 403);
      const targets = await app.inject({
        method: "GET",
        url: "/api/admin/monitor-targets",
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(targets.statusCode, 200);
      assert.equal(targets.headers["cache-control"], "no-store");
      assert.deepEqual(targets.json(), {
        items: [
          { key: "DMIT Premium", label: "DMIT Premium", state: "active" },
          { key: "Tokyo Transit A", label: "日本东京 VPS 中转 A", state: "active" },
          { key: "Paused VPS", label: "维护中的 VPS", state: "disabled" },
        ],
      });
      const unavailableApp = buildApp({
        payment: { ...dependencies, monitorTargetCatalog: null },
      });
      try {
        const unavailable = await unavailableApp.inject({
          method: "GET",
          url: "/api/admin/monitor-targets",
          headers: { cookie: adminSession.cookie },
        });
        assert.equal(unavailable.statusCode, 503);
        assert.deepEqual(unavailable.json(), {
          error: { code: "monitor_unavailable" },
        });
      } finally {
        await unavailableApp.close();
      }

      const badCsrf = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: { cookie: adminSession.cookie, "x-csrf-token": "x".repeat(43) },
      });
      assert.equal(badCsrf.statusCode, 403);
      assert.equal(firstValue(database, "SELECT status FROM services"), "pending_open");

      const adminSessionHash = computeSessionTokenHash(
        adminSession.rawToken,
        TOKEN_KEYRING,
      ).tokenHash;
      const csrf = issueCsrfToken(dependencies.csrfSigningKey, adminSessionHash);
      const disabledTarget = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [
            {
              label: "暂停线路",
              subscriptionUrl: "https://subscription.example.test/paused",
              monitorTargetKey: "Paused VPS",
            },
          ],
        },
      });
      assert.equal(disabledTarget.statusCode, 400);
      assert.deepEqual(disabledTarget.json(), {
        error: { code: "invalid_monitor_target" },
      });
      assert.equal(firstValue(database, "SELECT status FROM services"), "pending_open");

      const opened = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [
            {
              label: "订阅线路 1",
              subscriptionUrl: "https://subscription.example.test/customer",
              monitorTargetKey: "DMIT Premium",
            },
          ],
        },
      });
      assert.equal(opened.statusCode, 200);
      assert.deepEqual(opened.json(), {
        id: serviceId,
        status: "open",
        openedAt: "2026-08-21T00:00:00.000Z",
        items: [{
          position: 1,
          label: "订阅线路 1",
          monitorTargetKey: "DMIT Premium",
        }],
      });
      assert.equal(firstValue(database, "SELECT status FROM services"), "open");
      assert.deepEqual(
        allRows(database, "SELECT actor, action, target_ref FROM audit_log WHERE action = 'service.open'"),
        [
          {
            actor: "admin@example.com",
            action: "service.open",
            target_ref: order.orderRef,
          },
        ],
      );
      const repeated = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          items: [
            {
              label: "订阅线路 1",
              subscriptionUrl: "https://subscription.example.test/customer",
              monitorTargetKey: "DMIT Premium",
            },
          ],
        },
      });
      assert.equal(repeated.statusCode, 409);
    } finally {
      await app.close();
    }
  });
});

test("public catalog and quote stay anonymous, validate input, and map domain errors", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const app = buildApp({ payment: dependencies });
    try {
      const catalog = await app.inject({ method: "GET", url: "/api/catalog/plans" });
      assert.equal(catalog.statusCode, 200);
      assert.equal(catalog.headers["cache-control"], "no-store");
      const catalogItems = catalog.json().items as Array<Record<string, unknown>>;
      assert.equal(catalogItems.length, 255);
      assert.deepEqual(
        catalogItems.find(
          (item) =>
            item.typeId === "local-isp" &&
            item.regionId === "us" &&
            item.ispId === "us-verizon" &&
            item.specId === null &&
            item.durationId === "month-1",
        ),
        {
          typeId: "local-isp",
          regionId: "us",
          ispId: "us-verizon",
          specId: null,
          durationId: "month-1",
          priceFen: 7_900,
          isActive: true,
          soldOut: false,
        },
      );

      const invalid = await app.inject({
        method: "POST",
        url: "/api/pay/quote",
        headers: { "content-type": "application/json" },
        payload: { typeId: "local-isp" },
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json(), { error: { code: "invalid_selection" } });

      const quoted = await app.inject({
        method: "POST",
        url: "/api/pay/quote",
        headers: { "content-type": "application/json" },
        payload: { ...localIspSelection(), couponCode: null },
      });
      assert.equal(quoted.statusCode, 200);
      assert.equal(quoted.headers["cache-control"], "no-store");
      assert.deepEqual(quoted.json(), {
        listPriceFen: 7_900,
        discountFen: 0,
        amountFen: 7_900,
        currency: "CNY",
        couponCode: null,
      });

      const unknownCoupon = await app.inject({
        method: "POST",
        url: "/api/pay/quote",
        headers: { "content-type": "application/json" },
        payload: { ...localIspSelection(), couponCode: "DOES_NOT_EXIST" },
      });
      assert.equal(unknownCoupon.statusCode, 409);
      assert.deepEqual(unknownCoupon.json(), { error: { code: "coupon_invalid" } });

      const offSale = await app.inject({
        method: "POST",
        url: "/api/pay/quote",
        headers: { "content-type": "application/json" },
        payload: {
          typeId: "residential",
          regionId: "us",
          ispId: "comcast",
          specId: "dedicated",
          durationId: "month-12",
          couponCode: null,
        },
      });
      assert.equal(offSale.statusCode, 409);
      assert.deepEqual(offSale.json(), { error: { code: "plan_unavailable" } });
    } finally {
      await app.close();
    }
  });
});

test("admin plans require an admin session and CSRF, validate patches, and map plan errors", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "plan-user@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "plan-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const userSession = insertWebSession(database, userId);
    const adminSession = insertWebSession(database, adminId);
    const dependencies = paymentDependencies(database);
    const app = buildApp({ payment: dependencies });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/admin/plans" });
      assert.equal(anonymous.statusCode, 401);
      assert.deepEqual(anonymous.json(), { error: { code: "unauthorized" } });

      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/plans",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(forbidden.statusCode, 403);
      assert.deepEqual(forbidden.json(), { error: { code: "forbidden" } });

      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/plans",
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(listed.statusCode, 200);
      const plans = listed.json().items as Array<Record<string, unknown>>;
      assert.equal(plans.length, 255);
      const plan = plans.find(
        (item) =>
          item.typeId === "local-isp" &&
          item.regionId === "us" &&
          item.ispId === "us-verizon" &&
          item.specId === null &&
          item.durationId === "month-1",
      );
      assert.ok(plan);
      assert.equal(typeof plan.id, "number");
      const planId = plan.id as number;

      const missingCsrf = await app.inject({
        method: "PATCH",
        url: `/api/admin/plans/${planId}`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
        },
        payload: { priceFen: 8_500 },
      });
      assert.equal(missingCsrf.statusCode, 403);
      assert.deepEqual(missingCsrf.json(), { error: { code: "csrf_invalid" } });

      const adminSessionHash = computeSessionTokenHash(
        adminSession.rawToken,
        TOKEN_KEYRING,
      ).tokenHash;
      const csrf = issueCsrfToken(dependencies.csrfSigningKey, adminSessionHash);

      const invalid = await app.inject({
        method: "PATCH",
        url: `/api/admin/plans/${planId}`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: { priceFen: 0 },
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json(), { error: { code: "invalid_plan_patch" } });

      const missing = await app.inject({
        method: "PATCH",
        url: "/api/admin/plans/999999",
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: { priceFen: 8_500 },
      });
      assert.equal(missing.statusCode, 404);
      assert.deepEqual(missing.json(), { error: { code: "not_found" } });

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/admin/plans/${planId}`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: { priceFen: 8_500, totalSlots: 1, isActive: true },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().id, planId);
      assert.equal(updated.json().priceFen, 8_500);
      assert.equal(updated.json().totalSlots, 1);
      assert.equal(updated.json().occupiedSlots, 0);
      assert.equal(updated.json().isActive, true);

      createPaymentOrder(dependencies, {
        idempotencyKey: "admin-plan-stock-key",
        rawAccessToken: ACCESS_TOKEN_A,
        selection: localIspSelection(),
        contact: "stock-customer",
        scenarios: [],
        notes: null,
        acknowledgedAmountFen: 8_500,
        userId: null,
      });

      const belowOccupied = await app.inject({
        method: "PATCH",
        url: `/api/admin/plans/${planId}`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: { totalSlots: 0 },
      });
      assert.equal(belowOccupied.statusCode, 409);
      assert.deepEqual(belowOccupied.json(), { error: { code: "invalid_slots" } });
    } finally {
      await app.close();
    }
  });
});

test("admin coupons require admin and CSRF, support their main flow, and reject immutable patches", async () => {
  await withAuthenticationDatabase(async (database) => {
    const userId = insertAuthenticationUser(database, {
      email: "coupon-user@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "coupon-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const userSession = insertWebSession(database, userId);
    const adminSession = insertWebSession(database, adminId);
    const dependencies = paymentDependencies(database);
    const app = buildApp({ payment: dependencies });
    try {
      const anonymous = await app.inject({ method: "GET", url: "/api/admin/coupons" });
      assert.equal(anonymous.statusCode, 401);
      assert.deepEqual(anonymous.json(), { error: { code: "unauthorized" } });

      const forbidden = await app.inject({
        method: "GET",
        url: "/api/admin/coupons",
        headers: { cookie: userSession.cookie },
      });
      assert.equal(forbidden.statusCode, 403);
      assert.deepEqual(forbidden.json(), { error: { code: "forbidden" } });

      const adminSessionHash = computeSessionTokenHash(
        adminSession.rawToken,
        TOKEN_KEYRING,
      ).tokenHash;
      const csrf = issueCsrfToken(dependencies.csrfSigningKey, adminSessionHash);

      const planRows = allRows(
        database,
        `SELECT id FROM sellable_plans
         WHERE type_id = 'local-isp' AND region_id = 'us' AND isp_id = 'us-verizon'
           AND spec_id IS NULL AND duration_id = 'month-1'`,
      );
      assert.equal(planRows.length, 1);
      assert.equal(typeof planRows[0]?.id, "number");
      const planId = planRows[0]?.id as number;
      const payload = {
        code: "web10",
        kind: "percent",
        amountOffFen: null,
        percentOff: 10,
        minAmountFen: null,
        scope: "plans",
        planIds: [planId],
        startsAt: "2026-01-01T00:00:00.000Z",
        endsAt: "2027-01-01T00:00:00.000Z",
        maxRedemptions: 1,
      };

      const missingCsrf = await app.inject({
        method: "POST",
        url: "/api/admin/coupons",
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
        },
        payload,
      });
      assert.equal(missingCsrf.statusCode, 403);
      assert.deepEqual(missingCsrf.json(), { error: { code: "csrf_invalid" } });

      const invalid = await app.inject({
        method: "POST",
        url: "/api/admin/coupons",
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {},
      });
      assert.equal(invalid.statusCode, 400);
      assert.deepEqual(invalid.json(), { error: { code: "invalid_coupon" } });

      const created = await app.inject({
        method: "POST",
        url: "/api/admin/coupons",
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload,
      });
      assert.equal(created.statusCode, 200);
      assert.equal(created.json().code, "WEB10");
      assert.equal(created.json().kind, "percent");
      assert.equal(created.json().percentOff, 10);
      assert.deepEqual(created.json().planIds, [planId]);
      assert.equal(created.json().redeemedCount, 0);
      assert.equal(created.json().isActive, true);
      const couponId = created.json().id as number;

      const listed = await app.inject({
        method: "GET",
        url: "/api/admin/coupons",
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(listed.statusCode, 200);
      assert.equal(listed.json().items.length, 1);
      assert.equal(listed.json().items[0].id, couponId);

      const redemptions = await app.inject({
        method: "GET",
        url: `/api/admin/coupons/${couponId}/redemptions`,
        headers: { cookie: adminSession.cookie },
      });
      assert.equal(redemptions.statusCode, 200);
      assert.deepEqual(redemptions.json(), { items: [] });

      const quote = await app.inject({
        method: "POST",
        url: "/api/pay/quote",
        headers: { "content-type": "application/json" },
        payload: { ...localIspSelection(), couponCode: " web10 " },
      });
      assert.equal(quote.statusCode, 200);
      assert.deepEqual(quote.json(), {
        listPriceFen: 7_900,
        discountFen: 790,
        amountFen: 7_110,
        currency: "CNY",
        couponCode: "WEB10",
      });

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/admin/coupons/${couponId}`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: {
          isActive: false,
          endsAt: "2026-12-31T00:00:00.000Z",
          maxRedemptions: null,
        },
      });
      assert.equal(updated.statusCode, 200);
      assert.equal(updated.json().isActive, false);
      assert.equal(updated.json().endsAt, "2026-12-31T00:00:00.000Z");
      assert.equal(updated.json().maxRedemptions, null);

      const immutable = await app.inject({
        method: "PATCH",
        url: `/api/admin/coupons/${couponId}`,
        headers: {
          cookie: adminSession.cookie,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        payload: { code: "CHANGED" },
      });
      assert.equal(immutable.statusCode, 400);
      assert.deepEqual(immutable.json(), { error: { code: "immutable_field" } });
    } finally {
      await app.close();
    }
  });
});
