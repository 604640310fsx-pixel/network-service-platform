import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { NODE_STATUS_MAX_TARGETS, resolveNodeStatuses } from "../../src/monitor/node-status.js";
import {
  MonitorPrivateClientError,
  type MonitorPrivateClient,
  type MonitorPrivateStatus,
} from "../../src/monitor/private-client.js";
import type { MonitorTargetOption } from "../../src/monitor/target-catalog.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import { insertWebSession, TEST_NOW, TOKEN_KEYRING } from "../payment/helpers.js";

/** Private-channel fake: per-target answers; a missing target throws like an unreachable monitor. */
class FakeStatusClient implements MonitorPrivateClient {
  readonly calls: string[] = [];
  constructor(private readonly answers: Readonly<Record<string, MonitorPrivateStatus["status"]>>) {}

  async list(): Promise<readonly MonitorTargetOption[]> {
    return [];
  }

  async status(target: string): Promise<MonitorPrivateStatus> {
    this.calls.push(target);
    const status = this.answers[target];
    if (status === undefined) throw new MonitorPrivateClientError("unavailable");
    return { status, updatedAt: "2030-01-01T00:01:00Z", stale: status === "stale" };
  }
}

let sequence = 0;
function insertOpenService(database: DatabaseConnection, userId: number, adminId: number, targets: readonly (string | null)[]): string {
  sequence += 1;
  const now = TEST_NOW.toISOString();
  const orderRef = `DLNODESTATUS${sequence}`;
  database.prepare(
    `INSERT INTO orders (order_ref, idempotency_key, request_fingerprint, user_id, type_id, region_id, isp_id, spec_id,
       duration_id, catalog_version, amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'local-isp', 'us', 'us-verizon', NULL, 'month-1', 'test', 7900, 'CNY', 'c', '[]', NULL, 'paid', ?, ?)`,
  ).run(orderRef, `node-idem-${sequence}`, `node-fp-${sequence}`, userId, now, now);
  const orderId = (database.prepare("SELECT id FROM orders WHERE order_ref = ?").all(orderRef)[0] as { id: number }).id;
  database.prepare(
    `INSERT INTO payments (order_id, out_trade_no, channel, app_id, amount_fen, currency, status, trade_no,
       alipay_trade_status, last_queried_at, close_reason, paid_at, closed_at, created_at, updated_at)
     VALUES (?, ?, 'alipay_page', 'app', 7900, 'CNY', 'paid', ?, 'TRADE_SUCCESS', NULL, NULL, ?, NULL, ?, ?)`,
  ).run(orderId, orderRef, `trade-${sequence}`, now, now, now);
  const paymentId = (database.prepare("SELECT id FROM payments WHERE order_id = ?").all(orderId)[0] as { id: number }).id;
  database.prepare(
    `INSERT INTO services (payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at) VALUES (?, 'open', ?, ?, ?, ?)`,
  ).run(paymentId, adminId, now, now, now);
  const serviceId = (database.prepare("SELECT id FROM services WHERE payment_id = ?").all(paymentId)[0] as { id: number }).id;
  const insert = database.prepare(
    `INSERT INTO service_delivery_items (service_id, position, label, monitor_target_key, key_version, nonce, ciphertext, tag, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  targets.forEach((target, index) => {
    insert.run(serviceId, index + 1, `Line ${index + 1}`, target, Buffer.alloc(12, 1), Buffer.from("cipher"), Buffer.alloc(16, 1), now, now);
  });
  return orderRef;
}

function insertOpenGrant(database: DatabaseConnection, userId: number, adminId: number, status: "active" | "revoked" = "active"): number {
  const now = TEST_NOW.toISOString();
  database.prepare(
    `INSERT INTO admin_grants (user_id, granted_by_admin_id, label, starts_at, ends_at, status, reason, created_at, updated_at,
       delivery_status, opened_at)
     VALUES (?, ?, 'Gift', ?, NULL, ?, NULL, ?, ?, 'open', ?)`,
  ).run(userId, adminId, now, status, now, now, now);
  const grantId = (database.prepare("SELECT last_insert_rowid() AS id").all()[0] as { id: number }).id;
  database.prepare(
    `INSERT INTO admin_grant_delivery_items (grant_id, position, label, key_version, nonce, ciphertext, tag, created_at, updated_at)
     VALUES (?, 1, 'Gift line', 1, ?, ?, ?, ?, ?)`,
  ).run(grantId, Buffer.alloc(12, 2), Buffer.from("cipher"), Buffer.alloc(16, 2), now, now);
  return grantId;
}

function monitorDependencies(database: DatabaseConnection, privateClient: MonitorPrivateClient | null) {
  return { database, tokenHmacKeyring: TOKEN_KEYRING, rateLimitKeyring: TOKEN_KEYRING, privateClient, now: () => new Date(TEST_NOW) } as const;
}

test("node status maps each owned line to its target's status and degrades per line", async () => {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "node-buyer@example.com", passwordHash: "hash", status: "active" });
    const otherId = insertAuthenticationUser(database, { email: "node-other@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "node-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const orderA = insertOpenService(database, buyerId, adminId, ["hk-node-a.internal", "sg-node-b.internal", null]);
    const orderB = insertOpenService(database, buyerId, adminId, ["hk-node-a.internal", "us-node-c.internal", "jp-node-d.internal"]);
    insertOpenService(database, otherId, adminId, ["secret-other.internal"]);
    const grantId = insertOpenGrant(database, buyerId, adminId);
    insertOpenGrant(database, buyerId, adminId, "revoked");
    const client = new FakeStatusClient({ "hk-node-a.internal": "online", "sg-node-b.internal": "offline", "us-node-c.internal": "stale" });
    const app = buildApp({ monitor: monitorDependencies(database, client) });
    try {
      const buyer = insertWebSession(database, buyerId);
      const response = await app.inject({ method: "GET", url: "/api/me/node-status", headers: { cookie: buyer.cookie } });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json(), {
        monitor: "available",
        items: [
          { kind: "service", ref: orderB, position: 1, label: "Line 1", status: "online" },
          { kind: "service", ref: orderB, position: 2, label: "Line 2", status: "stale" },
          { kind: "service", ref: orderB, position: 3, label: "Line 3", status: "unknown" },
          { kind: "service", ref: orderA, position: 1, label: "Line 1", status: "online" },
          { kind: "service", ref: orderA, position: 2, label: "Line 2", status: "offline" },
          { kind: "service", ref: orderA, position: 3, label: "Line 3", status: "unbound" },
          { kind: "grant", ref: grantId, position: 1, label: "Gift line", status: "unbound" },
        ],
      });
      // Each distinct target is queried once; another buyer's target is never touched.
      assert.deepEqual([...client.calls].sort(), ["hk-node-a.internal", "jp-node-d.internal", "sg-node-b.internal", "us-node-c.internal"]);
      for (const secret of [".internal", "monitor_target", "targetKey", "secret-other"]) {
        assert.equal(response.body.includes(secret), false, `response must not contain ${secret}`);
      }

      const other = insertWebSession(database, otherId);
      const otherView = await app.inject({ method: "GET", url: "/api/me/node-status", headers: { cookie: other.cookie } });
      assert.deepEqual(otherView.json().items.map((item: { label: string; status: string }) => item.status), ["unknown"]);
      assert.equal(otherView.body.includes(orderA), false);

      const anonymous = await app.inject({ method: "GET", url: "/api/me/node-status" });
      assert.equal(anonymous.statusCode, 401);
      const withQuery = await app.inject({ method: "GET", url: "/api/me/node-status?target=x", headers: { cookie: buyer.cookie } });
      assert.equal(withQuery.statusCode, 400);
    } finally {
      await app.close();
    }
  });
});

test("node status reports monitor unavailable without failing the page when the private channel is off", async () => {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "node-off@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "node-off-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    insertOpenService(database, buyerId, adminId, ["hk-node-a.internal"]);
    const app = buildApp({ monitor: monitorDependencies(database, null) });
    try {
      const buyer = insertWebSession(database, buyerId);
      const response = await app.inject({ method: "GET", url: "/api/me/node-status", headers: { cookie: buyer.cookie } });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { monitor: "unavailable", items: [] });
    } finally {
      await app.close();
    }
  });
});

test("node status caps the private fan-out and marks the remainder unknown", async () => {
  const lines = Array.from({ length: NODE_STATUS_MAX_TARGETS + 3 }, (_, index) => ({
    kind: "service" as const,
    ref: "DL1",
    position: index + 1,
    label: `L${index + 1}`,
    targetKey: `t-${index}`,
  }));
  const calls: string[] = [];
  const items = await resolveNodeStatuses(lines, async (target) => {
    calls.push(target);
    return { status: "online", updatedAt: "2030-01-01T00:00:00Z", stale: false };
  });
  assert.equal(calls.length, NODE_STATUS_MAX_TARGETS);
  assert.deepEqual(items.slice(-3).map((item) => item.status), ["unknown", "unknown", "unknown"]);
  assert.equal(items.filter((item) => item.status === "online").length, NODE_STATUS_MAX_TARGETS);
});
