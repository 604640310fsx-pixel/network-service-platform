import assert from "node:assert/strict";
import test from "node:test";

import {
  createPaymentOrder,
  getAuthorizedOrderStatus,
  PaymentDomainError,
  retryPaymentOrder,
} from "../../src/payment/orders.js";
import {
  acceptPendingPaymentEvent,
  finalizeClosed,
  finalizePaid,
  type PaymentEventInput,
} from "../../src/payment/state-machine.js";
import { withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  ACCESS_TOKEN_C,
  allRows,
  firstValue,
  localIspSelection,
  paymentDependencies,
} from "./helpers.js";

function createOrder(
  dependencies: ReturnType<typeof paymentDependencies>,
  options: {
    readonly idempotencyKey?: string;
    readonly rawAccessToken?: string;
    readonly contact?: string;
  } = {},
) {
  return createPaymentOrder(dependencies, {
    idempotencyKey: options.idempotencyKey ?? "create-key-1",
    rawAccessToken: options.rawAccessToken ?? ACCESS_TOKEN_A,
    selection: localIspSelection(),
    contact: options.contact ?? "telegram-user",
    scenarios: ["TikTok / 社媒"],
    notes: "deliver carefully",
    acknowledgedAmountFen: 7_900,
    userId: null,
  });
}

function event(
  orderRef: string,
  tradeStatus: string,
  notifyId: string,
  overrides: Partial<PaymentEventInput> = {},
): PaymentEventInput {
  return {
    outTradeNo: orderRef,
    tradeNo: "trade-123",
    tradeStatus,
    totalAmount: "79.00",
    totalAmountFen: 7_900,
    appId: "app-123",
    sellerId: "seller-456",
    notification: { notifyId, payloadHash: `hash-${notifyId}` },
    ...overrides,
  };
}

test("SUCCESS and FINISHED atomically create exactly one paid service", async () => {
  for (const status of ["TRADE_SUCCESS", "TRADE_FINISHED"] as const) {
    await withAuthenticationDatabase((database) => {
      const dependencies = paymentDependencies(database);
      const order = createOrder(dependencies);
      assert.equal(finalizePaid(dependencies, event(order.orderRef, status, `n-${status}`)), "finalized");
      assert.equal(firstValue(database, "SELECT status FROM orders"), "paid");
      assert.equal(firstValue(database, "SELECT status FROM payments"), "paid");
      assert.equal(firstValue(database, "SELECT status FROM services"), "pending_open");
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 1);
    });
  }
});

test("CLOSED closes pending, authoritative SUCCESS restores closed to paid, and paid never downgrades", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const order = createOrder(dependencies);
    assert.equal(
      finalizeClosed(dependencies, event(order.orderRef, "TRADE_CLOSED", "n-close")),
      "finalized",
    );
    assert.equal(firstValue(database, "SELECT status FROM payments"), "closed");
    assert.equal(firstValue(database, "SELECT status FROM orders"), "closed");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);

    assert.equal(
      finalizePaid(dependencies, event(order.orderRef, "TRADE_SUCCESS", "n-success")),
      "finalized",
    );
    assert.deepEqual(
      allRows(
        database,
        "SELECT status, close_reason, closed_at, paid_at FROM payments",
      ),
      [
        {
          status: "paid",
          close_reason: null,
          closed_at: null,
          paid_at: "2026-08-21T00:00:00.000Z",
        },
      ],
    );
    assert.equal(firstValue(database, "SELECT status FROM orders"), "paid");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);

    assert.equal(
      finalizeClosed(dependencies, event(order.orderRef, "TRADE_CLOSED", "n-late-close")),
      "ignored_paid",
    );
    assert.equal(firstValue(database, "SELECT status FROM payments"), "paid");
    assert.equal(firstValue(database, "SELECT status FROM orders"), "paid");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
  });
});

test("WAIT remains pending and accepted notifications are idempotent", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const order = createOrder(dependencies);
    const wait = event(order.orderRef, "WAIT_BUYER_PAY", "n-wait");
    assert.equal(acceptPendingPaymentEvent(dependencies, wait), "accepted_pending");
    assert.equal(acceptPendingPaymentEvent(dependencies, wait), "idempotent_replay");
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    assert.equal(firstValue(database, "SELECT status FROM orders"), "pending");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 1);
  });
});

test("repeated success notifications never create a second service and mismatches are rejected", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const order = createOrder(dependencies);
    const first = event(order.orderRef, "TRADE_SUCCESS", "n-first");
    assert.equal(finalizePaid(dependencies, first), "finalized");
    assert.equal(finalizePaid(dependencies, first), "idempotent_replay");
    assert.equal(
      finalizePaid(dependencies, event(order.orderRef, "TRADE_FINISHED", "n-second")),
      "idempotent_replay",
    );
    assert.equal(
      finalizePaid(
        dependencies,
        event(order.orderRef, "TRADE_SUCCESS", "n-first", {
          tradeNo: "conflicting-trade",
        }),
      ),
      "rejected",
    );
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 2);
    assert.equal(
      firstValue(
        database,
        "SELECT COUNT(*) FROM audit_log WHERE action LIKE 'payment.%mismatch' OR action = 'payment.event_rejected'",
      ),
      1,
    );
  });
});

test("service insertion failure rolls notification, payment, and order back together", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const order = createOrder(dependencies);
    database.exec(`
      CREATE TRIGGER payment_test_service_failure
      BEFORE INSERT ON services
      BEGIN
        SELECT RAISE(ABORT, 'service insertion failed');
      END;
    `);
    const paid = event(order.orderRef, "TRADE_SUCCESS", "n-rollback");
    assert.throws(() => finalizePaid(dependencies, paid), /service insertion failed/);
    assert.equal(firstValue(database, "SELECT status FROM payments"), "pending");
    assert.equal(firstValue(database, "SELECT status FROM orders"), "pending");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 0);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 0);

    database.exec("DROP TRIGGER payment_test_service_failure");
    assert.equal(finalizePaid(dependencies, paid), "finalized");
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM services"), 1);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payment_notifications"), 1);
  });
});

test("order creation is idempotent only for the same fingerprint and access token", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const first = createOrder(dependencies);
    const replay = createOrder(dependencies);
    assert.equal(replay.orderRef, first.orderRef);
    assert.equal(replay.reservedUntil, first.reservedUntil);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM orders"), 1);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM payments"), 1);
    assert.equal(firstValue(database, "SELECT COUNT(*) FROM order_access_tokens"), 1);

    assert.throws(
      () => createOrder(dependencies, { contact: "different-contact" }),
      (error: unknown) =>
        error instanceof PaymentDomainError &&
        error.statusCode === 409 &&
        error.code === "idempotency_key_conflict",
    );
    assert.throws(
      () => createOrder(dependencies, { rawAccessToken: ACCESS_TOKEN_B }),
      (error: unknown) =>
        error instanceof PaymentDomainError &&
        error.statusCode === 409 &&
        error.code === "idempotency_key_conflict",
    );
    assert.throws(
      () =>
        createPaymentOrder(dependencies, {
          idempotencyKey: "create-key-1",
          rawAccessToken: ACCESS_TOKEN_A,
          selection: localIspSelection(),
          contact: "telegram-user",
          scenarios: ["TikTok / 社媒"],
          notes: "deliver carefully",
          acknowledgedAmountFen: 1,
          userId: null,
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError &&
        error.statusCode === 409 &&
        error.code === "idempotency_key_conflict",
    );
    finalizeClosed(
      dependencies,
      event(first.orderRef, "TRADE_CLOSED", "n-idempotent-close"),
    );
    const terminalReplay = createOrder(dependencies);
    assert.equal(terminalReplay.status, "closed");
    assert.equal(terminalReplay.reservedUntil, null);
  });
});

test("retry copies a closed snapshot, re-prices it, and requires a distinct new credential", async () => {
  await withAuthenticationDatabase((database) => {
    let sequence = 0;
    const dependencies = paymentDependencies(database, undefined, () => {
      sequence += 1;
      return `${sequence.toString().padStart(8, "0")}-1111-4111-8111-111111111111`;
    });
    const oldOrder = createOrder(dependencies);
    finalizeClosed(
      dependencies,
      event(oldOrder.orderRef, "TRADE_CLOSED", "n-close-retry"),
    );
    const retried = retryPaymentOrder(dependencies, {
      oldOrderRef: oldOrder.orderRef,
      idempotencyKey: "retry-key-1",
      oldRawAccessToken: ACCESS_TOKEN_A,
      newRawAccessToken: ACCESS_TOKEN_B,
      currentUserId: null,
    });
    assert.notEqual(retried.orderRef, oldOrder.orderRef);
    assert.equal(retried.status, "pending");
    assert.deepEqual(
      allRows(
        database,
        `SELECT type_id, region_id, isp_id, spec_id, duration_id,
                amount_fen, contact, scenarios, notes, status
         FROM orders ORDER BY id`,
      ),
      [
        {
          type_id: "local-isp",
          region_id: "us",
          isp_id: "us-verizon",
          spec_id: null,
          duration_id: "month-1",
          amount_fen: 7_900,
          contact: "telegram-user",
          scenarios: '["TikTok / 社媒"]',
          notes: "deliver carefully",
          status: "closed",
        },
        {
          type_id: "local-isp",
          region_id: "us",
          isp_id: "us-verizon",
          spec_id: null,
          duration_id: "month-1",
          amount_fen: 7_900,
          contact: "telegram-user",
          scenarios: '["TikTok / 社媒"]',
          notes: "deliver carefully",
          status: "pending",
        },
      ],
    );
    finalizePaid(
      dependencies,
      event(oldOrder.orderRef, "TRADE_SUCCESS", "n-old-late-success"),
    );
    const retryReplay = retryPaymentOrder(dependencies, {
      oldOrderRef: oldOrder.orderRef,
      idempotencyKey: "retry-key-1",
      oldRawAccessToken: ACCESS_TOKEN_A,
      newRawAccessToken: ACCESS_TOKEN_B,
      currentUserId: null,
    });
    assert.equal(retryReplay.orderRef, retried.orderRef);
    assert.throws(
      () =>
        retryPaymentOrder(dependencies, {
          oldOrderRef: oldOrder.orderRef,
          idempotencyKey: "retry-key-2",
          oldRawAccessToken: ACCESS_TOKEN_A,
          newRawAccessToken: ACCESS_TOKEN_A,
          currentUserId: null,
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError && error.statusCode === 409,
    );
  });
});

test("guest status authorization uses a valid non-revoked 30-day token and otherwise returns one 404", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const order = createOrder(dependencies);
    assert.equal(
      getAuthorizedOrderStatus(dependencies, {
        orderRef: order.orderRef,
        userId: null,
        rawAccessToken: ACCESS_TOKEN_A,
      }).status,
      "pending",
    );
    for (const rawAccessToken of [null, ACCESS_TOKEN_B, "invalid"]) {
      assert.throws(
        () =>
          getAuthorizedOrderStatus(dependencies, {
            orderRef: order.orderRef,
            userId: null,
            rawAccessToken,
          }),
        (error: unknown) =>
          error instanceof PaymentDomainError &&
          error.statusCode === 404 &&
          error.code === "not_found",
      );
    }
    database
      .prepare("UPDATE order_access_tokens SET revoked_at = ?")
      .run("2026-08-21T00:00:00.000Z");
    assert.throws(
      () =>
        getAuthorizedOrderStatus(dependencies, {
          orderRef: order.orderRef,
          userId: null,
          rawAccessToken: ACCESS_TOKEN_A,
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError && error.code === "not_found",
    );
    database
      .prepare("UPDATE order_access_tokens SET revoked_at = NULL, expires_at = ?")
      .run("2026-08-20T23:59:59.999Z");
    assert.throws(
      () =>
        getAuthorizedOrderStatus(dependencies, {
          orderRef: order.orderRef,
          userId: null,
          rawAccessToken: ACCESS_TOKEN_A,
        }),
      (error: unknown) =>
        error instanceof PaymentDomainError && error.code === "not_found",
    );
  });
});

test("payment DDL rejects illegal terminal fields and duplicate one-to-one rows", async () => {
  await withAuthenticationDatabase((database) => {
    const dependencies = paymentDependencies(database);
    const order = createOrder(dependencies);
    assert.throws(
      () =>
        database
          .prepare("UPDATE payments SET status = 'paid', trade_no = ?, paid_at = NULL")
          .run("trade-illegal"),
      /CHECK constraint failed/,
    );
    finalizePaid(
      dependencies,
      event(order.orderRef, "TRADE_SUCCESS", "n-unique"),
    );
    const paymentId = firstValue(database, "SELECT id FROM payments");
    assert.equal(typeof paymentId, "number");
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO services (
               payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at
             ) VALUES (?, 'pending_open', NULL, NULL, ?, ?)`,
          )
          .run(paymentId, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO payment_notifications (
               notify_id, payment_id, out_trade_no, trade_no, trade_status,
               total_amount, payload_hash, received_at
             ) SELECT notify_id, payment_id, out_trade_no, trade_no, trade_status,
                      total_amount, payload_hash, received_at
               FROM payment_notifications LIMIT 1`,
          )
          .run(),
      /UNIQUE constraint failed/,
    );
  });
});
