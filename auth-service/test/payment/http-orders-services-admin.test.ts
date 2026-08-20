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

test("create-order API stores only the client credential hash and returns only orderRef/status/payUrl", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
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
      assert.deepEqual(Object.keys(body).sort(), ["orderRef", "payUrl", "status"]);
      assert.equal(body.status, "pending");
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
      assert.equal(sdk.pageCalls.length, 1);
    } finally {
      await app.close();
    }
  });
});

test("server pricing rejects changed and over-limit amounts before any SDK page call", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const app = buildApp({ payment: dependencies });
    try {
      const changed = await app.inject({
        method: "POST",
        url: "/api/pay/orders",
        headers: {
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
      assert.equal(overLimit.statusCode, 409);
      assert.deepEqual(overLimit.json(), {
        error: { code: "amount_limit_exceeded", maxSingleFen: 200_000 },
      });
      assert.equal(sdk.pageCalls.length, 0);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 0);
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
    try {
      const unauthorized = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${old.orderRef}/retry`,
        headers: {
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
          "idempotency-key": "retry-key",
          "x-order-access-token": ACCESS_TOKEN_A,
          "x-new-order-access-token": ACCESS_TOKEN_B,
        },
      });
      assert.equal(retried.statusCode, 200);
      assert.deepEqual(Object.keys(retried.json()).sort(), [
        "orderRef",
        "payUrl",
        "status",
      ]);
      assert.notEqual(retried.json().orderRef, old.orderRef);
      assert.equal(retried.body.includes(ACCESS_TOKEN_B), false);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 2);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM order_access_tokens"), 2);
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
      const opened = await app.inject({
        method: "POST",
        url: `/api/admin/services/${serviceId}/open`,
        headers: { cookie: adminSession.cookie, "x-csrf-token": csrf },
      });
      assert.equal(opened.statusCode, 200);
      assert.equal(opened.json().status, "open");
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
        headers: { cookie: adminSession.cookie, "x-csrf-token": csrf },
      });
      assert.equal(repeated.statusCode, 409);
    } finally {
      await app.close();
    }
  });
});
