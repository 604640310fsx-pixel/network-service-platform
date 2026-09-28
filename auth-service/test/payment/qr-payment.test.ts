import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizeClosed, finalizePaid } from "../../src/payment/state-machine.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  FakeAlipaySdk,
  TEST_NOW,
  allRows,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
  queryResult,
} from "./helpers.js";

const EXPECTED_RESERVATION = "2026-08-21T00:30:00.000Z";

function createPayload() {
  return {
    ...localIspSelection(),
    contact: "page-pay-test-contact",
    scenarios: ["AI 工具"],
    notes: null,
    acknowledgedAmountFen: 7_900,
    couponCode: null,
  };
}

function createPendingOrder(
  dependencies: ReturnType<typeof paymentDependencies>,
  options: {
    readonly idempotencyKey?: string;
    readonly rawAccessToken?: string;
  } = {},
) {
  return createPaymentOrder(dependencies, {
    idempotencyKey: options.idempotencyKey ?? "page-pay-order-key",
    rawAccessToken: options.rawAccessToken ?? ACCESS_TOKEN_A,
    selection: localIspSelection(),
    contact: "page-pay-test-contact",
    scenarios: ["AI 工具"],
    notes: null,
    acknowledgedAmountFen: 7_900,
    userId: null,
  });
}

function assertFrozenResult(
  body: Record<string, unknown>,
  expected: {
    readonly orderRef: string;
    readonly status: "pending" | "paid" | "closed";
    readonly payUrl: string | null;
    readonly reservedUntil: string | null;
  },
): void {
  assert.deepEqual(Object.keys(body).sort(), [
    "amountFen",
    "currency",
    "orderRef",
    "payUrl",
    "reservedUntil",
    "status",
  ]);
  assert.deepEqual(body, {
    orderRef: expected.orderRef,
    status: expected.status,
    amountFen: 7_900,
    currency: "CNY",
    reservedUntil: expected.reservedUntil,
    payUrl: expected.payUrl,
  });
}

function persistedPaymentText(database: Parameters<typeof allRows>[0]): string {
  const tables = [
    "orders",
    "payments",
    "order_access_tokens",
    "services",
    "payment_notifications",
    "audit_log",
  ];
  return JSON.stringify(tables.flatMap((table) => allRows(database, `SELECT * FROM ${table}`)));
}

test("pending pay-page lookup reuses order authorization and never duplicates local payment state", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createPendingOrder(dependencies);
    const app = buildApp({ payment: dependencies });
    try {
      for (const accessToken of [null, ACCESS_TOKEN_B]) {
        const unauthorized = await app.inject({
          method: "POST",
          url: `/api/pay/orders/${order.orderRef}/pay-page`,
          headers: accessToken === null ? undefined : { "x-order-access-token": accessToken },
          payload: {},
        });
        assert.equal(unauthorized.statusCode, 404);
        assert.deepEqual(unauthorized.json(), { error: { code: "not_found" } });
      }

      const first = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${order.orderRef}/pay-page`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
        payload: {},
      });
      const second = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${order.orderRef}/pay-page`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
        payload: {},
      });
      assert.equal(first.statusCode, 200);
      assert.equal(second.statusCode, 200);
      const payUrl = `https://alipay.example.test/pay/${order.orderRef}`;
      assertFrozenResult(first.json(), {
        orderRef: order.orderRef,
        status: "pending",
        reservedUntil: EXPECTED_RESERVATION,
        payUrl,
      });
      assert.deepEqual(second.json(), first.json());
      assert.equal(sdk.pageCalls.length, 2);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM payments"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM order_access_tokens"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 0);
      assert.equal(
        firstValue(
          database,
          `SELECT occupied_slots FROM sellable_plans
           WHERE type_id = 'local-isp' AND region_id = 'us'
             AND isp_id = 'us-verizon' AND spec_id IS NULL
             AND duration_id = 'month-1'`,
        ),
        1,
      );
      assert.equal(persistedPaymentText(database).includes(payUrl), false);
    } finally {
      await app.close();
    }
  });
});

test("GET snapshot exposes the reservation but never returns a signed pay URL", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createPendingOrder(dependencies);
    sdk.queryResponse = queryResult({
      tradeStatus: "WAIT_BUYER_PAY",
      outTradeNo: order.orderRef,
    });
    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        orderRef: order.orderRef,
        status: "pending",
        amountFen: 7_900,
        currency: "CNY",
        reservedUntil: EXPECTED_RESERVATION,
        service: null,
      });
      assert.equal(Object.hasOwn(response.json(), "payUrl"), false);
    } finally {
      await app.close();
    }
  });
});

test("a transient pageExecute failure preserves the order and same-key retry returns its pay URL", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const sensitiveFailureText = "gateway-failure-with-pay-url-sentinel";
    sdk.pageResults.push(new Error(sensitiveFailureText));
    const dependencies = paymentDependencies(database, sdk);
    const app = buildApp({ payment: dependencies });
    const capturedLogs: string[] = [];
    const originalError = console.error;
    const originalWarn = console.warn;
    console.error = (...values: unknown[]) => capturedLogs.push(values.map(String).join(" "));
    console.warn = (...values: unknown[]) => capturedLogs.push(values.map(String).join(" "));
    try {
      const buyerId = insertAuthenticationUser(database, {
        email: "page-pay-buyer@example.com",
        passwordHash: "hash",
        status: "active",
      });
      const buyerSession = insertWebSession(database, buyerId);
      const request = {
        method: "POST" as const,
        url: "/api/pay/orders",
        headers: {
          cookie: buyerSession.cookie,
          "x-csrf-token": buyerSession.csrfToken,
          "content-type": "application/json",
          "idempotency-key": "page-pay-retry-key",
          "x-order-access-token": ACCESS_TOKEN_A,
        },
        payload: createPayload(),
      };
      const failed = await app.inject(request);
      assert.equal(failed.statusCode, 503);
      assert.deepEqual(failed.json(), { error: { code: "payment_unavailable" } });
      assert.equal(failed.body.includes(sensitiveFailureText), false);
      const storedOrderRef = String(firstValue(database, "SELECT order_ref FROM orders"));
      assert.equal(firstValue(database, "SELECT status FROM orders"), "pending");
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM payments"), 1);

      const recovered = await app.inject(request);
      assert.equal(recovered.statusCode, 200);
      const payUrl = `https://alipay.example.test/pay/${storedOrderRef}`;
      assertFrozenResult(recovered.json(), {
        orderRef: storedOrderRef,
        status: "pending",
        reservedUntil: EXPECTED_RESERVATION,
        payUrl,
      });
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM payments"), 1);
      assert.equal(
        firstValue(
          database,
          `SELECT occupied_slots FROM sellable_plans
           WHERE type_id = 'local-isp' AND region_id = 'us'
             AND isp_id = 'us-verizon' AND spec_id IS NULL
             AND duration_id = 'month-1'`,
        ),
        1,
      );
      assert.equal(persistedPaymentText(database).includes(payUrl), false);
      assert.equal(persistedPaymentText(database).includes(sensitiveFailureText), false);
      assert.equal(capturedLogs.join("\n").includes(sensitiveFailureText), false);
    } finally {
      console.error = originalError;
      console.warn = originalWarn;
      await app.close();
    }
  });
});

test("paid and closed pay-page requests return terminal nulls without another pageExecute", async () => {
  for (const status of ["paid", "closed"] as const) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createPendingOrder(dependencies);
      if (status === "paid") {
        finalizePaid(dependencies, {
          outTradeNo: order.orderRef,
          tradeNo: "trade-terminal",
          tradeStatus: "TRADE_SUCCESS",
          totalAmount: "79.00",
          totalAmountFen: 7_900,
          appId: "app-123",
          sellerId: "seller-456",
        });
      } else {
        finalizeClosed(dependencies, {
          outTradeNo: order.orderRef,
          tradeNo: "trade-terminal",
          tradeStatus: "TRADE_CLOSED",
          totalAmount: "79.00",
          totalAmountFen: 7_900,
          appId: "app-123",
          sellerId: "seller-456",
        });
      }
      const app = buildApp({ payment: dependencies });
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/pay/orders/${order.orderRef}/pay-page`,
          headers: { "x-order-access-token": ACCESS_TOKEN_A },
          payload: {},
        });
        assert.equal(response.statusCode, 200);
        assertFrozenResult(response.json(), {
          orderRef: order.orderRef,
          status,
          reservedUntil: null,
          payUrl: null,
        });
        assert.equal(sdk.pageCalls.length, 0);
      } finally {
        await app.close();
      }
    });
  }
});

test("pay-page lookup uses the authoritative query before returning a terminal result", async () => {
  for (const remoteStatus of ["TRADE_SUCCESS", "TRADE_CLOSED"] as const) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createPendingOrder(dependencies);
      sdk.queryResponse = queryResult({
        tradeStatus: remoteStatus,
        outTradeNo: order.orderRef,
      });
      const app = buildApp({ payment: dependencies });
      try {
        const response = await app.inject({
          method: "POST",
          url: `/api/pay/orders/${order.orderRef}/pay-page`,
          headers: { "x-order-access-token": ACCESS_TOKEN_A },
          payload: {},
        });
        assert.equal(response.statusCode, 200);
        assertFrozenResult(response.json(), {
          orderRef: order.orderRef,
          status: remoteStatus === "TRADE_SUCCESS" ? "paid" : "closed",
          reservedUntil: null,
          payUrl: null,
        });
        assert.equal(sdk.queryCalls.length, 1);
        assert.equal(sdk.pageCalls.length, 0);
      } finally {
        await app.close();
      }
    });
  }
});

test("an expired pending reservation cannot mint a fresh pay URL or alter state", async () => {
  await withAuthenticationDatabase(async (database) => {
    let currentTime = new Date(TEST_NOW);
    const sdk = new FakeAlipaySdk();
    const dependencies = {
      ...paymentDependencies(database, sdk),
      now: () => new Date(currentTime),
    };
    const order = createPendingOrder(dependencies);
    currentTime = new Date(TEST_NOW.getTime() + 30 * 60 * 1_000);
    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/pay/orders/${order.orderRef}/pay-page`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
        payload: {},
      });
      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: { code: "qr_unavailable" } });
      assert.equal(sdk.pageCalls.length, 0);
      assert.equal(firstValue(database, "SELECT status FROM orders"), "pending");
      assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    } finally {
      await app.close();
    }
  });
});
