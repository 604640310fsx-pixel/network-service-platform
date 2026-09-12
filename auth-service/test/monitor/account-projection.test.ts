import assert from "node:assert/strict";
import test from "node:test";

import type { DatabaseConnection } from "../../src/db.js";
import {
  AccountMonitorSelectionError,
  selectAccountMonitorTarget,
} from "../../src/monitor/account-projection.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";

const NOW = "2026-08-21T00:00:00.000Z";

type StoredState = {
  readonly order?: "pending" | "paid" | "closed";
  readonly payment?: "pending" | "paid" | "closed";
  readonly service?: "pending_open" | "open";
};

function firstId(
  database: DatabaseConnection,
  source: string,
  parameter: string | number,
): number {
  const row = database.prepare(source).all(parameter)[0] as
    | { readonly id: unknown }
    | undefined;
  if (typeof row?.id !== "number") throw new Error("test row id is invalid");
  return row.id;
}

function insertService(
  database: DatabaseConnection,
  sequence: number,
  userId: number,
  adminId: number,
  targets: readonly (string | null)[],
  state: StoredState = {},
): number {
  const orderStatus = state.order ?? "paid";
  const paymentStatus = state.payment ?? "paid";
  const serviceStatus = state.service ?? "open";
  const orderRef = `DLPROJECTION${sequence}`;
  database.prepare(
    `INSERT INTO orders (
       order_ref, idempotency_key, request_fingerprint, user_id,
       type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
       amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'local-isp', 'us', 'us-verizon', NULL, 'month-1',
       'test', 7900, 'CNY', 'projection-test', '[]', NULL, ?, ?, ?)`,
  ).run(
    orderRef,
    `projection-idempotency-${sequence}`,
    `projection-fingerprint-${sequence}`,
    userId,
    orderStatus,
    NOW,
    NOW,
  );
  const orderId = firstId(database, "SELECT id FROM orders WHERE order_ref = ?", orderRef);
  const paid = paymentStatus === "paid";
  const closed = paymentStatus === "closed";
  database.prepare(
    `INSERT INTO payments (
       order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
       trade_no, alipay_trade_status, last_queried_at, close_reason,
       paid_at, closed_at, created_at, updated_at
     ) VALUES (?, ?, 'alipay_page', 'app-123', 7900, 'CNY', ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
  ).run(
    orderId,
    orderRef,
    paymentStatus,
    paid ? `trade-${sequence}` : null,
    paid ? "TRADE_SUCCESS" : null,
    closed ? "alipay_trade_closed" : null,
    paid ? NOW : null,
    closed ? NOW : null,
    NOW,
    NOW,
  );
  const paymentId = firstId(database, "SELECT id FROM payments WHERE order_id = ?", orderId);
  const open = serviceStatus === "open";
  database.prepare(
    `INSERT INTO services (
       payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(paymentId, serviceStatus, open ? adminId : null, open ? NOW : null, NOW, NOW);
  const serviceId = firstId(database, "SELECT id FROM services WHERE payment_id = ?", paymentId);

  const insertItem = database.prepare(
    `INSERT INTO service_delivery_items (
       service_id, position, label, monitor_target_key, key_version,
       nonce, ciphertext, tag, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  targets.forEach((target, index) => {
    insertItem.run(
      serviceId,
      index + 1,
      `线路 ${index + 1}`,
      target,
      Buffer.alloc(12, sequence),
      Buffer.from(`cipher-${sequence}-${index}`),
      Buffer.alloc(16, sequence),
      NOW,
      NOW,
    );
  });
  return serviceId;
}

test("account selector enforces ownership and exact paid/open ordering in SQL", async () => {
  assert.equal(selectAccountMonitorTarget.length, 2);
  const selectorSource = selectAccountMonitorTarget.toString();
  assert.match(
    selectorSource,
    /JOIN payments ON payments\.id = services\.payment_id/,
  );
  assert.match(
    selectorSource,
    /JOIN orders ON orders\.id = payments\.order_id/,
  );
  assert.doesNotMatch(selectorSource, /services\.order_id/);
  await withAuthenticationDatabase((database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "projection-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const otherId = insertAuthenticationUser(database, {
      email: "projection-other@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "projection-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });

    insertService(database, 1, ownerId, adminId, ["older-bound"]);
    insertService(database, 2, ownerId, adminId, [null, "newest-position-two", "later"]);
    insertService(database, 3, ownerId, adminId, ["wrong-order-state"], { order: "pending" });
    insertService(database, 4, ownerId, adminId, ["wrong-payment-state"], { payment: "pending" });
    insertService(database, 5, ownerId, adminId, ["wrong-service-state"], { service: "pending_open" });
    insertService(database, 6, otherId, adminId, ["other-owner"]);

    assert.deepEqual(selectAccountMonitorTarget(database, ownerId), {
      key: "newest-position-two",
    });
    assert.deepEqual(selectAccountMonitorTarget(database, otherId), {
      key: "other-owner",
    });
  });
});

test("account selector distinguishes no eligible service from all-null bindings", async () => {
  await withAuthenticationDatabase((database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "projection-empty@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "projection-empty-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    assert.throws(
      () => selectAccountMonitorTarget(database, ownerId),
      (error: unknown) =>
        error instanceof AccountMonitorSelectionError &&
        error.code === "no_eligible_service",
    );

    insertService(database, 1, ownerId, adminId, [null, null]);
    assert.throws(
      () => selectAccountMonitorTarget(database, ownerId),
      (error: unknown) =>
        error instanceof AccountMonitorSelectionError &&
        error.code === "monitor_unbound",
    );
  });
});

test("account selector does not fall back after the first non-null binding is invalid", async () => {
  await withAuthenticationDatabase((database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "projection-invalid@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "projection-invalid-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    insertService(database, 1, ownerId, adminId, ["older-valid"]);
    insertService(database, 2, ownerId, adminId, ["bad\nkey", "newer-valid"]);
    assert.throws(
      () => selectAccountMonitorTarget(database, ownerId),
      /selection invariant failed/,
    );
  });
});
