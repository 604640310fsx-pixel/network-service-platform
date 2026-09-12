import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { consumeMonitorStatusRateLimit } from "../../src/http/rate-limit.js";
import {
  MonitorPrivateClientError,
  type MonitorPrivateClient,
  type MonitorPrivateStatus,
} from "../../src/monitor/private-client.js";
import type { MonitorTargetOption } from "../../src/monitor/target-catalog.js";
import {
  insertAuthenticationUser,
  withAuthenticationDatabase,
} from "../auth/helpers.js";
import {
  insertWebSession,
  TEST_NOW,
  TOKEN_KEYRING,
} from "../payment/helpers.js";

class FakePrivateClient implements MonitorPrivateClient {
  catalog: readonly MonitorTargetOption[] = [
    { key: "target-a", label: "账户服务器 A", state: "active" },
    { key: "target-b", label: "账户服务器 B", state: "active" },
  ];
  projection: MonitorPrivateStatus = {
    status: "online",
    updatedAt: "2030-01-01T00:01:00Z",
    stale: false,
  };
  listFailure: MonitorPrivateClientError | null = null;
  statusFailure: MonitorPrivateClientError | null = null;
  readonly listSignals: Array<AbortSignal | undefined> = [];
  readonly statusCalls: Array<{ target: string; signal: AbortSignal | undefined }> = [];

  async list(signal?: AbortSignal): Promise<readonly MonitorTargetOption[]> {
    this.listSignals.push(signal);
    if (this.listFailure !== null) throw this.listFailure;
    return this.catalog;
  }

  async status(target: string, signal?: AbortSignal): Promise<MonitorPrivateStatus> {
    this.statusCalls.push({ target, signal });
    if (this.statusFailure !== null) throw this.statusFailure;
    return this.projection;
  }
}

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

function insertOpenService(
  database: DatabaseConnection,
  sequence: number,
  userId: number,
  adminId: number,
  targets: readonly (string | null)[],
): number {
  const now = TEST_NOW.toISOString();
  const orderRef = `DLHTTPMONITOR${sequence}`;
  database.prepare(
    `INSERT INTO orders (
       order_ref, idempotency_key, request_fingerprint, user_id,
       type_id, region_id, isp_id, spec_id, duration_id, catalog_version,
       amount_fen, currency, contact, scenarios, notes, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'local-isp', 'us', 'us-verizon', NULL, 'month-1',
       'test', 7900, 'CNY', 'monitor-http-test', '[]', NULL, 'paid', ?, ?)`,
  ).run(
    orderRef,
    `monitor-http-idempotency-${sequence}`,
    `monitor-http-fingerprint-${sequence}`,
    userId,
    now,
    now,
  );
  const orderId = firstId(database, "SELECT id FROM orders WHERE order_ref = ?", orderRef);
  database.prepare(
    `INSERT INTO payments (
       order_id, out_trade_no, channel, app_id, amount_fen, currency, status,
       trade_no, alipay_trade_status, last_queried_at, close_reason,
       paid_at, closed_at, created_at, updated_at
     ) VALUES (?, ?, 'alipay_page', 'app-123', 7900, 'CNY', 'paid', ?,
       'TRADE_SUCCESS', NULL, NULL, ?, NULL, ?, ?)`,
  ).run(orderId, orderRef, `trade-${sequence}`, now, now, now);
  const paymentId = firstId(database, "SELECT id FROM payments WHERE order_id = ?", orderId);
  database.prepare(
    `INSERT INTO services (
       payment_id, status, opened_by_admin_id, opened_at, created_at, updated_at
     ) VALUES (?, 'open', ?, ?, ?, ?)`,
  ).run(paymentId, adminId, now, now, now);
  const serviceId = firstId(database, "SELECT id FROM services WHERE payment_id = ?", paymentId);
  const insert = database.prepare(
    `INSERT INTO service_delivery_items (
       service_id, position, label, monitor_target_key, key_version,
       nonce, ciphertext, tag, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  );
  targets.forEach((target, index) => {
    insert.run(
      serviceId,
      index + 1,
      `线路 ${index + 1}`,
      target,
      Buffer.alloc(12, sequence),
      Buffer.from(`cipher-${sequence}-${index}`),
      Buffer.alloc(16, sequence),
      now,
      now,
    );
  });
  return serviceId;
}

function dependencies(
  database: DatabaseConnection,
  privateClient: MonitorPrivateClient | null,
) {
  return {
    database,
    tokenHmacKeyring: TOKEN_KEYRING,
    rateLimitKeyring: TOKEN_KEYRING,
    privateClient,
    now: () => new Date(TEST_NOW),
  } as const;
}

test("monitor endpoint derives the first owned binding and returns the exact customer projection", async (context) => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "monitor-http-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "monitor-http-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const owner = insertWebSession(database, ownerId);
    insertOpenService(database, 1, ownerId, adminId, ["target-a", "target-b"]);
    const client = new FakePrivateClient();
    const app = buildApp({ monitor: dependencies(database, client) });
    context.after(async () => app.close());

    const response = await app.inject({
      method: "GET",
      url: "/api/me/monitor-status",
      headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.match(response.headers["content-type"] ?? "", /^application\/json/);
    assert.deepEqual(response.json(), {
      label: "账户服务器 A",
      status: "online",
      updatedAt: "2030-01-01T00:01:00Z",
      stale: false,
    });
    assert.deepEqual(Object.keys(response.json()).sort(), ["label", "stale", "status", "updatedAt"]);
    assert.equal(response.body.includes("target-a"), false);
    assert.equal(response.body.includes("monitorTargetKey"), false);
    assert.deepEqual(client.statusCalls.map((call) => call.target), ["target-a"]);
    assert.equal(client.listSignals.length, 1);
    assert.equal(client.statusCalls[0]?.signal, client.listSignals[0]);
  });
});

test("authenticated request headers are non-authoritative and cannot change selection", async (context) => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "monitor-header-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "monitor-header-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const owner = insertWebSession(database, ownerId);
    insertOpenService(database, 1, ownerId, adminId, ["target-a"]);
    const client = new FakePrivateClient();
    const app = buildApp({ monitor: dependencies(database, client) });
    context.after(async () => app.close());

    const variants = [
      {},
      { authorization: "Bearer ignored" },
      { "x-csrf-token": "ignored" },
      { "x-forwarded-user": "999", "x-untrusted-value": "target-b" },
    ] as const;
    for (const headers of variants) {
      const response = await app.inject({
        method: "GET",
        url: "/api/me/monitor-status",
        headers: { cookie: owner.cookie, ...headers },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        label: "账户服务器 A",
        status: "online",
        updatedAt: "2030-01-01T00:01:00Z",
        stale: false,
      });
    }
    assert.deepEqual(
      client.statusCalls.map((call) => call.target),
      variants.map(() => "target-a"),
    );
  });
});

test("monitor endpoint enforces auth, role, method, query, body, and no-store gates", async (context) => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "monitor-gates-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "monitor-gates-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const owner = insertWebSession(database, ownerId);
    const admin = insertWebSession(database, adminId);
    insertOpenService(database, 1, ownerId, adminId, ["target-a"]);
    const client = new FakePrivateClient();
    const app = buildApp({ monitor: dependencies(database, client) });
    context.after(async () => app.close());

    const cases = [
      {
        request: { method: "GET", url: "/api/me/monitor-status" } as const,
        status: 401,
        code: "unauthorized",
      },
      {
        request: {
          method: "GET",
          url: "/api/me/monitor-status",
          headers: { cookie: admin.cookie },
        } as const,
        status: 403,
        code: "forbidden",
      },
      {
        request: {
          method: "GET",
          url: "/api/me/monitor-status?target=target-a",
          headers: { cookie: owner.cookie },
        } as const,
        status: 400,
        code: "invalid_request",
      },
      {
        request: {
          method: "GET",
          url: "/api/me/monitor-status",
          headers: {
            cookie: owner.cookie,
            "content-type": "text/plain",
          },
          payload: "x",
        } as const,
        status: 400,
        code: "invalid_request",
      },
      {
        request: {
          method: "GET",
          url: "/api/me/monitor-status",
          headers: {
            cookie: owner.cookie,
            "content-length": "2",
            "content-type": "application/json",
          },
          payload: "{}",
        } as const,
        status: 400,
        code: "invalid_request",
      },
      ...(["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const).map(
        (method) => ({
          request: {
            method,
            url: "/api/me/monitor-status",
            headers: { cookie: owner.cookie },
          } as const,
          status: 405,
          code: "method_not_allowed",
        }),
      ),
    ];
    for (const entry of cases) {
      const response = await app.inject(entry.request);
      assert.equal(response.statusCode, entry.status);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.deepEqual(response.json(), { error: { code: entry.code } });
      if (entry.status === 405) assert.equal(response.headers.allow, "GET");
    }
    // light-my-request's method union omits TRACE, but Fastify accepts and routes it.
    const traceResponse = await app.inject({
      method: "TRACE" as "GET",
      url: "/api/me/monitor-status",
      headers: { cookie: owner.cookie },
    });
    assert.equal(traceResponse.statusCode, 405);
    assert.equal(traceResponse.headers["cache-control"], "no-store");
    assert.equal(traceResponse.headers.allow, "GET");
    assert.deepEqual(traceResponse.json(), { error: { code: "method_not_allowed" } });
    assert.deepEqual(client.statusCalls, []);
  });
});

test("monitor endpoint distinguishes no service, null binding, and inactive first binding without fallback", async (context) => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "monitor-selection-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "monitor-selection-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const owner = insertWebSession(database, ownerId);
    const client = new FakePrivateClient();
    const app = buildApp({ monitor: dependencies(database, client) });
    context.after(async () => app.close());
    const get = () => app.inject({
      method: "GET",
      url: "/api/me/monitor-status",
      headers: { cookie: owner.cookie },
    });

    let response = await get();
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), { error: { code: "no_eligible_service" } });

    const serviceId = insertOpenService(database, 1, ownerId, adminId, [null]);
    response = await get();
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: { code: "monitor_unbound" } });

    database.prepare(
      "UPDATE service_delivery_items SET monitor_target_key = 'target-a' WHERE service_id = ?",
    ).run(serviceId);
    client.catalog = [
      { key: "target-a", label: "disabled first", state: "disabled" },
      { key: "target-b", label: "active second", state: "active" },
    ];
    response = await get();
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.json(), { error: { code: "monitor_unbound" } });
    assert.deepEqual(client.statusCalls, []);
  });
});

test("monitor endpoint maps private failures and configuration closed without leaking details", async (context) => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "monitor-failure-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const adminId = insertAuthenticationUser(database, {
      email: "monitor-failure-admin@example.com",
      passwordHash: "hash",
      status: "active",
      role: "admin",
    });
    const owner = insertWebSession(database, ownerId);
    insertOpenService(database, 1, ownerId, adminId, ["target-a"]);
    const client = new FakePrivateClient();
    const app = buildApp({ monitor: dependencies(database, client) });
    const disabled = buildApp({ monitor: dependencies(database, null) });
    context.after(async () => {
      await Promise.all([app.close(), disabled.close()]);
    });

    const disabledResponse = await disabled.inject({
      method: "GET",
      url: "/api/me/monitor-status",
      headers: { cookie: owner.cookie },
    });
    assert.equal(disabledResponse.statusCode, 503);
    assert.deepEqual(disabledResponse.json(), { error: { code: "monitor_unconfigured" } });

    for (const [failure, status, code] of [
      ["timeout", 504, "monitor_unavailable"],
      ["unavailable", 503, "monitor_unavailable"],
      ["invalid_response", 502, "monitor_invalid_response"],
      ["target_unbound", 409, "monitor_unbound"],
    ] as const) {
      client.listFailure = new MonitorPrivateClientError(failure);
      const response = await app.inject({
        method: "GET",
        url: "/api/me/monitor-status",
        headers: { cookie: owner.cookie },
      });
      assert.equal(response.statusCode, status);
      assert.deepEqual(response.json(), { error: { code } });
      assert.equal(response.body.includes("target-a"), false);
    }
  });
});

test("monitor endpoint enforces the 120 per hour user rate after authentication", async (context) => {
  await withAuthenticationDatabase(async (database) => {
    const ownerId = insertAuthenticationUser(database, {
      email: "monitor-rate-owner@example.com",
      passwordHash: "hash",
      status: "active",
    });
    const owner = insertWebSession(database, ownerId);
    for (let count = 0; count < 120; count += 1) {
      consumeMonitorStatusRateLimit(database, TOKEN_KEYRING, ownerId, {
        now: () => new Date(TEST_NOW),
      });
    }
    const client = new FakePrivateClient();
    const app = buildApp({ monitor: dependencies(database, client) });
    context.after(async () => app.close());
    const response = await app.inject({
      method: "GET",
      url: "/api/me/monitor-status",
      headers: { cookie: owner.cookie },
    });
    assert.equal(response.statusCode, 429);
    assert.deepEqual(response.json(), { error: { code: "rate_limited" } });
    assert.deepEqual(client.listSignals, []);
  });
});
