import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizeClosed } from "../../src/payment/state-machine.js";
import { withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  FakeAlipaySdk,
  firstValue,
  localIspSelection,
  paymentDependencies,
  queryResult,
} from "./helpers.js";

function createOrder(
  dependencies: ReturnType<typeof paymentDependencies>,
) {
  return createPaymentOrder(dependencies, {
    idempotencyKey: "http-order-key",
    rawAccessToken: ACCESS_TOKEN_A,
    selection: localIspSelection(),
    contact: "telegram-user",
    scenarios: ["TikTok / 社媒"],
    notes: null,
    acknowledgedAmountFen: 7_900,
    userId: null,
  });
}

function notifyFields(orderRef: string): Record<string, string> {
  return {
    sign: "signed-value",
    sign_type: "RSA2",
    notify_id: "notify-1",
    app_id: "app-123",
    seller_id: "seller-456",
    out_trade_no: orderRef,
    trade_no: "trade-123",
    trade_status: "TRADE_SUCCESS",
    total_amount: "79.00",
  };
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

test("PAYMENT_ENABLED=false makes every payment business endpoint 503 while health stays available", async (context) => {
  const app = buildApp({ payment: { enabled: false } });
  context.after(async () => app.close());

  const responses = await Promise.all([
    app.inject({ method: "POST", url: "/api/pay/orders", payload: {} }),
    app.inject({ method: "POST", url: "/api/pay/orders/DL1/retry" }),
    app.inject({ method: "GET", url: "/api/pay/orders/DL1" }),
    app.inject({
      method: "POST",
      url: "/api/pay/alipay/notify",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody(notifyFields("DL1")),
    }),
    app.inject({ method: "GET", url: "/api/me/services" }),
    app.inject({
      method: "GET",
      url: "/api/admin/services?status=pending_open",
    }),
    app.inject({ method: "POST", url: "/api/admin/services/1/open" }),
  ]);
  assert.deepEqual(
    responses.map((response) => response.statusCode),
    [503, 503, 503, 503, 503, 503, 503],
  );
  const health = await app.inject({ method: "GET", url: "/health" });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), { status: "ok" });
});

test("notify rejects each duplicate critical field before signature verification", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createOrder(dependencies);
    const app = buildApp({ payment: dependencies });
    try {
      const fields = notifyFields(order.orderRef);
      for (const field of [
        "sign",
        "sign_type",
        "notify_id",
        "app_id",
        "seller_id",
        "out_trade_no",
        "trade_no",
        "trade_status",
        "total_amount",
      ]) {
        const payload = `${formBody(fields)}&${encodeURIComponent(field)}=duplicate`;
        const response = await app.inject({
          method: "POST",
          url: "/api/pay/alipay/notify",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload,
        });
        assert.equal(response.statusCode, 400, field);
        assert.equal(response.body, "failure", field);
      }
      for (const field of [
        "sign",
        "sign_type",
        "notify_id",
        "app_id",
        "seller_id",
        "out_trade_no",
        "trade_no",
        "trade_status",
        "total_amount",
      ]) {
        const missing = { ...fields };
        delete missing[field];
        const response = await app.inject({
          method: "POST",
          url: "/api/pay/alipay/notify",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: formBody(missing),
        });
        assert.equal(response.statusCode, 400, `missing ${field}`);
        assert.equal(response.body, "failure", `missing ${field}`);
      }
      assert.equal(sdk.notifyBodies.length, 0);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 0);
      assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    } finally {
      await app.close();
    }
  });
});

test("notify parser enforces the exact 65536-byte scoped body limit", async () => {
  await withAuthenticationDatabase(async (database) => {
    const dependencies = paymentDependencies(database);
    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/pay/alipay/notify",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `padding=${"x".repeat(65_537)}`,
      });
      assert.equal(response.statusCode, 413);
    } finally {
      await app.close();
    }
  });
});

test("verified notify maps SUCCESS, WAIT, CLOSED and unknown without fake payment", async () => {
  for (const [tradeStatus, expectedStatus, expectedBody] of [
    ["TRADE_SUCCESS", "paid", "success"],
    ["WAIT_BUYER_PAY", "pending", "success"],
    ["TRADE_CLOSED", "closed", "success"],
    ["UNRECOGNIZED", "pending", "failure"],
  ] as const) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createOrder(dependencies);
      const app = buildApp({ payment: dependencies });
      try {
        const fields = {
          ...notifyFields(order.orderRef),
          trade_status: tradeStatus,
        };
        const response = await app.inject({
          method: "POST",
          url: "/api/pay/alipay/notify",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: formBody(fields),
        });
        assert.equal(response.body, expectedBody);
        assert.equal(firstValue(database, "SELECT status FROM payments"), expectedStatus);
        assert.equal(
          firstValue(database, "SELECT COUNT(*) FROM services"),
          expectedStatus === "paid" ? 1 : 0,
        );
      } finally {
        await app.close();
      }
    });
  }
});

test("signature, merchant, amount, and unknown-order failures do not enter accepted notifications", async () => {
  for (const mutation of [
    (fields: Record<string, string>) => ({ fields, verified: false }),
    (fields: Record<string, string>) => ({
      fields: { ...fields, app_id: "wrong-app" },
      verified: true,
    }),
    (fields: Record<string, string>) => ({
      fields: { ...fields, seller_id: "wrong-seller" },
      verified: true,
    }),
    (fields: Record<string, string>) => ({
      fields: { ...fields, total_amount: "80.00" },
      verified: true,
    }),
    (fields: Record<string, string>) => ({
      fields: { ...fields, out_trade_no: "DL-unknown" },
      verified: true,
    }),
  ]) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createOrder(dependencies);
      const app = buildApp({ payment: dependencies });
      try {
        const attempt = mutation(notifyFields(order.orderRef));
        sdk.verifyNotify = attempt.verified;
        const response = await app.inject({
          method: "POST",
          url: "/api/pay/alipay/notify",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: formBody(attempt.fields),
        });
        assert.equal(response.body, "failure");
        assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
        assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);
        assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 0);
      } finally {
        await app.close();
      }
    });
  }
});

test("authorized status query invokes fake SDK outside the state transaction and shares status mapping", async () => {
  for (const [tradeStatus, expectedStatus] of [
    ["TRADE_SUCCESS", "paid"],
    ["TRADE_FINISHED", "paid"],
    ["TRADE_CLOSED", "closed"],
    ["WAIT_BUYER_PAY", "pending"],
  ] as const) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createOrder(dependencies);
      sdk.queryResponse = queryResult({
        tradeStatus,
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
        assert.equal(response.json().status, expectedStatus);
        assert.deepEqual(sdk.queryCalls, [order.orderRef]);
        assert.deepEqual(sdk.queryOptions, [{ validateSign: true }]);
        assert.equal(
          firstValue(database, "SELECT COUNT(*) FROM payment_notifications"),
          0,
        );
        assert.equal(
          firstValue(database, "SELECT COUNT(*) FROM services"),
          expectedStatus === "paid" ? 1 : 0,
        );
      } finally {
        await app.close();
      }
    });
  }
});

test("query mismatch, unknown response, and network failure keep local pending", async () => {
  for (const responseOrError of [
    { code: "10000", tradeStatus: "UNKNOWN", outTradeNo: "ignored" },
    {
      code: "10000",
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: "wrong-order",
      tradeNo: "trade-123",
      totalAmount: "79.00",
    },
    new Error("network unavailable"),
  ]) {
    await withAuthenticationDatabase(async (database) => {
      const sdk = new FakeAlipaySdk();
      const dependencies = paymentDependencies(database, sdk);
      const order = createOrder(dependencies);
      if (responseOrError instanceof Error) {
        sdk.exec = async () => {
          throw responseOrError;
        };
      } else {
        sdk.queryResponse = responseOrError;
      }
      const app = buildApp({ payment: dependencies });
      try {
        const response = await app.inject({
          method: "GET",
          url: `/api/pay/orders/${order.orderRef}`,
          headers: { "x-order-access-token": ACCESS_TOKEN_A },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().status, "pending");
        assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);
        assert.equal(firstValue(database, "SELECT COUNT(*) FROM audit_log"), 1);
      } finally {
        await app.close();
      }
    });
  }
});

test("signed authoritative query SUCCESS restores a locally closed payment", async () => {
  await withAuthenticationDatabase(async (database) => {
    const sdk = new FakeAlipaySdk();
    const dependencies = paymentDependencies(database, sdk);
    const order = createOrder(dependencies);
    finalizeClosed(dependencies, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-123",
      tradeStatus: "TRADE_CLOSED",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "notify-query-close", payloadHash: "close" },
    });
    sdk.queryResponse = queryResult({
      tradeStatus: "TRADE_SUCCESS",
      outTradeNo: order.orderRef,
      tradeNo: "trade-123",
    });
    const app = buildApp({ payment: dependencies });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/api/pay/orders/${order.orderRef}`,
        headers: { "x-order-access-token": ACCESS_TOKEN_A },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().status, "paid");
      assert.equal(response.json().service.status, "pending_open");
      assert.deepEqual(sdk.queryOptions, [{ validateSign: true }]);
    } finally {
      await app.close();
    }
  });
});
