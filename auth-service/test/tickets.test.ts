import assert from "node:assert/strict";
import test from "node:test";

import { buildApp } from "../src/app.js";
import type { DatabaseConnection } from "../src/db.js";
import { createPaymentOrder } from "../src/payment/orders.js";
import { finalizePaid } from "../src/payment/state-machine.js";
import { TICKET_MESSAGES_MAX } from "../src/tickets/tickets.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "./auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  ACCESS_TOKEN_B,
  CSRF_KEY,
  TEST_NOW,
  TOKEN_KEYRING,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
} from "./payment/helpers.js";

type Session = ReturnType<typeof insertWebSession>;

function ticketApp(database: DatabaseConnection) {
  let sequence = 0;
  return buildApp({
    tickets: {
      database,
      tokenHmacKeyring: TOKEN_KEYRING,
      csrfSigningKey: CSRF_KEY,
      now: () => new Date(TEST_NOW),
      randomRef: () => {
        sequence += 1;
        return Buffer.from(sequence.toString(16).padStart(16, "0"), "hex");
      },
    },
  });
}

function user(database: DatabaseConnection, email: string, role: "user" | "admin" = "user") {
  const id = insertAuthenticationUser(database, { email, passwordHash: "hash", status: "active", role });
  return { id, session: insertWebSession(database, id) };
}

function writeHeaders(session: Session | null, csrf: string | null = session?.csrfToken ?? null) {
  return {
    "content-type": "application/json",
    ...(session ? { cookie: session.cookie } : {}),
    ...(csrf ? { "x-csrf-token": csrf } : {}),
  };
}

type App = ReturnType<typeof ticketApp>;
const post = (app: App, url: string, session: Session | null, payload: unknown, csrf?: string | null) =>
  app.inject({ method: "POST", url, headers: writeHeaders(session, csrf === undefined ? session?.csrfToken ?? null : csrf), payload: payload as Record<string, unknown> });
const get = (app: App, url: string, session: Session | null) =>
  app.inject({ method: "GET", url, headers: session ? { cookie: session.cookie } : {} });

test("every ticket route rejects anonymous callers, CSRF-less writes, and non-admin admin access", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    const ref = "TK0000000000000001";
    try {
      const routes: Array<[string, string]> = [
        ["POST", "/api/me/tickets"], ["GET", "/api/me/tickets"], ["GET", `/api/me/tickets/${ref}`],
        ["POST", `/api/me/tickets/${ref}/messages`], ["GET", "/api/admin/tickets"], ["GET", `/api/admin/tickets/${ref}`],
        ["POST", `/api/admin/tickets/${ref}/messages`], ["POST", `/api/admin/tickets/${ref}/status`],
      ];
      for (const [method, url] of routes) {
        const anonymous = await app.inject({ method: method as "GET" | "POST", url, payload: method === "POST" ? {} : undefined });
        assert.equal(anonymous.statusCode, 401, `${method} ${url}`);
        assert.deepEqual(anonymous.json(), { error: { code: "unauthorized" } });
      }
      for (const url of ["/api/me/tickets", `/api/me/tickets/${ref}/messages`]) {
        const missing = await post(app, url, customer.session, { subject: "s", body: "b" }, null);
        assert.equal(missing.statusCode, 403);
        assert.deepEqual(missing.json(), { error: { code: "csrf_invalid" } });
        const forged = await post(app, url, customer.session, { subject: "s", body: "b" }, "x".repeat(43));
        assert.equal(forged.statusCode, 403);
      }
      for (const [method, url] of routes.filter(([, url]) => url.startsWith("/api/admin"))) {
        const response = method === "GET" ? await get(app, url, customer.session) : await post(app, url, customer.session, { body: "b" });
        assert.equal(response.statusCode, 403, `${method} ${url}`);
        assert.deepEqual(response.json(), { error: { code: "forbidden" } });
      }
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM tickets"), 0);
    } finally {
      await app.close();
    }
  });
});

test("customers own their tickets; foreign and unknown refs share one 404", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const alice = user(database, "alice@example.test");
    const bob = user(database, "bob@example.test");
    try {
      const withOwner = await post(app, "/api/me/tickets", alice.session, { subject: "s", body: "b", userId: bob.id });
      assert.equal(withOwner.statusCode, 400, "client-supplied owner fields are rejected");
      const created = await post(app, "/api/me/tickets", alice.session, { subject: "Latency spike", body: "<b>hello</b>\nline 2" });
      assert.equal(created.statusCode, 200);
      const ticket = created.json().ticket;
      assert.match(ticket.ref, /^TK[0-9A-F]{16}$/);
      assert.equal(ticket.status, "open");
      assert.equal(ticket.serviceOrderRef, null);
      assert.deepEqual(ticket.messages, [{ role: "customer", body: "<b>hello</b>\nline 2", createdAt: TEST_NOW.toISOString() }]);
      assert.equal(firstValue(database, "SELECT user_id FROM tickets WHERE ticket_ref = ?", ticket.ref), alice.id);

      assert.equal((await get(app, "/api/me/tickets", alice.session)).json().items.length, 1);
      assert.deepEqual((await get(app, "/api/me/tickets", bob.session)).json(), { items: [], page: 1, hasMore: false });

      const notFound = { error: { code: "not_found" } };
      for (const url of [`/api/me/tickets/${ticket.ref}`, "/api/me/tickets/TKFFFFFFFFFFFFFFFF", "/api/me/tickets/not-a-ref"]) {
        const response = await get(app, url, bob.session);
        assert.equal(response.statusCode, 404, url);
        assert.deepEqual(response.json(), notFound);
      }
      const foreignReply = await post(app, `/api/me/tickets/${ticket.ref}/messages`, bob.session, { body: "hijack" });
      assert.equal(foreignReply.statusCode, 404);
      assert.deepEqual(foreignReply.json(), notFound);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM ticket_messages"), 1);
    } finally {
      await app.close();
    }
  });
});

test("status follows replies, only admins close, and closed tickets are frozen", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    const admin = user(database, "admin@example.test", "admin");
    try {
      const ref = (await post(app, "/api/me/tickets", customer.session, { subject: "s", body: "first" })).json().ticket.ref;
      const status = async () => (await get(app, `/api/me/tickets/${ref}`, customer.session)).json().ticket.status;

      assert.equal((await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "more" })).json().ticket.status, "open");
      const answered = await post(app, `/api/admin/tickets/${ref}/messages`, admin.session, { body: "answer" });
      assert.equal(answered.statusCode, 200);
      assert.equal(answered.json().ticket.status, "answered");
      assert.equal(answered.json().ticket.customerEmail, "customer@example.test");
      assert.equal(await status(), "answered");
      assert.equal((await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "follow-up" })).json().ticket.status, "open");

      const detail = (await get(app, `/api/admin/tickets/${ref}`, admin.session)).json().ticket;
      assert.deepEqual(detail.messages.map((m: { role: string }) => m.role), ["customer", "customer", "admin", "customer"]);
      assert.equal((await get(app, "/api/admin/tickets?status=open", admin.session)).json().items.length, 1);
      assert.equal((await get(app, "/api/admin/tickets?status=closed", admin.session)).json().items.length, 0);

      assert.equal((await post(app, `/api/admin/tickets/${ref}/status`, admin.session, { status: "open" })).statusCode, 400);
      assert.equal((await post(app, `/api/admin/tickets/${ref}/status`, admin.session, { status: "answered" })).statusCode, 400);
      const closed = await post(app, `/api/admin/tickets/${ref}/status`, admin.session, { status: "closed" });
      assert.equal(closed.statusCode, 200);
      assert.equal(closed.json().ticket.status, "closed");
      assert.equal(closed.json().ticket.closedAt, TEST_NOW.toISOString());

      const conflict = { error: { code: "ticket_closed" } };
      for (const response of [
        await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "reopen?" }),
        await post(app, `/api/admin/tickets/${ref}/messages`, admin.session, { body: "late" }),
        await post(app, `/api/admin/tickets/${ref}/status`, admin.session, { status: "closed" }),
      ]) {
        assert.equal(response.statusCode, 409);
        assert.deepEqual(response.json(), conflict);
      }
      assert.equal(await status(), "closed");
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM audit_log WHERE action = 'ticket.reply' AND target_ref = ?", ref), 1);
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM audit_log WHERE action = 'ticket.close' AND target_ref = ?", ref), 1);
    } finally {
      await app.close();
    }
  });
});

test("plain-text input is bounded and malformed payloads or queries are rejected", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    try {
      for (const payload of [
        {}, { subject: "", body: "b" }, { subject: "s", body: "   " }, { subject: "x".repeat(121), body: "b" },
        { subject: "s", body: "x".repeat(4001) }, { subject: "two\nlines", body: "b" }, { subject: "s", body: "bell\u0007" },
        { subject: 1, body: "b" }, { subject: "s", body: "b", serviceOrderRef: 5 }, { subject: "s", body: "b", serviceOrderRef: "../x" },
      ]) {
        const response = await post(app, "/api/me/tickets", customer.session, payload);
        assert.equal(response.statusCode, 400, JSON.stringify(payload).slice(0, 60));
        assert.deepEqual(response.json(), { error: { code: "invalid_request" } });
      }
      const edge = await post(app, "/api/me/tickets", customer.session, { subject: "x".repeat(120), body: "y".repeat(4000) });
      assert.equal(edge.statusCode, 200);
      for (const query of ["?page=0", "?page=abc", "?page=501", "?other=1"]) {
        assert.equal((await get(app, `/api/me/tickets${query}`, customer.session)).statusCode, 400, query);
      }
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM tickets"), 1);
    } finally {
      await app.close();
    }
  });
});

test("a service link must belong to the ticket owner", async () => {
  await withAuthenticationDatabase(async (database) => {
    let sequence = 0;
    const payment = paymentDependencies(database, undefined, () => {
      sequence += 1;
      return `${sequence.toString().padStart(8, "0")}-6666-4666-8666-666666666666`;
    });
    const app = ticketApp(database);
    const owner = user(database, "owner@example.test");
    const other = user(database, "other@example.test");
    const paidOrder = (userId: number, token: string, key: string) => {
      const order = createPaymentOrder(payment, {
        idempotencyKey: key, rawAccessToken: token, selection: localIspSelection(), contact: "c",
        scenarios: [], notes: null, acknowledgedAmountFen: 7_900, userId,
      });
      finalizePaid(payment, {
        outTradeNo: order.orderRef, tradeNo: `trade-${key}`, tradeStatus: "TRADE_SUCCESS", totalAmount: "79.00",
        totalAmountFen: 7_900, appId: "app-123", sellerId: "seller-456", notification: { notifyId: `n-${key}`, payloadHash: `h-${key}` },
      });
      return order.orderRef;
    };
    const ownRef = paidOrder(owner.id, ACCESS_TOKEN_A, "own");
    const foreignRef = paidOrder(other.id, ACCESS_TOKEN_B, "foreign");
    try {
      const linked = await post(app, "/api/me/tickets", owner.session, { subject: "s", body: "b", serviceOrderRef: ownRef });
      assert.equal(linked.statusCode, 200);
      assert.equal(linked.json().ticket.serviceOrderRef, ownRef);
      for (const serviceOrderRef of [foreignRef, "DL00000000999999999999999999999999"]) {
        const rejected = await post(app, "/api/me/tickets", owner.session, { subject: "s", body: "b", serviceOrderRef });
        assert.equal(rejected.statusCode, 400);
        assert.deepEqual(rejected.json(), { error: { code: "invalid_service" } });
      }
      assert.equal(firstValue(database, "SELECT COUNT(*) FROM tickets"), 1);
    } finally {
      await app.close();
    }
  });
});

test("lists paginate in bounded pages and threads stop at the message cap", async () => {
  await withAuthenticationDatabase(async (database) => {
    const app = ticketApp(database);
    const customer = user(database, "customer@example.test");
    const admin = user(database, "admin@example.test", "admin");
    try {
      for (let index = 0; index < 21; index += 1) {
        assert.equal((await post(app, "/api/me/tickets", customer.session, { subject: `t${index}`, body: "b" })).statusCode, 200);
      }
      const first = (await get(app, "/api/me/tickets", customer.session)).json();
      assert.equal(first.items.length, 20);
      assert.equal(first.hasMore, true);
      const second = (await get(app, "/api/me/tickets?page=2", customer.session)).json();
      assert.deepEqual([second.items.length, second.page, second.hasMore], [1, 2, false]);
      assert.equal((await get(app, "/api/admin/tickets?page=2", admin.session)).json().items.length, 1);

      const ref = first.items[0].ref;
      const ticketId = firstValue(database, "SELECT id FROM tickets WHERE ticket_ref = ?", ref);
      const insert = database.prepare(
        "INSERT INTO ticket_messages (ticket_id, author_role, author_user_id, body, created_at) VALUES (?, 'customer', ?, 'x', ?)",
      );
      for (let count = 1; count < TICKET_MESSAGES_MAX - 1; count += 1) insert.run(ticketId, customer.id, TEST_NOW.toISOString());
      assert.equal((await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "last" })).statusCode, 200);
      const capped = await post(app, `/api/me/tickets/${ref}/messages`, customer.session, { body: "over" });
      assert.equal(capped.statusCode, 409);
      assert.deepEqual(capped.json(), { error: { code: "message_limit_reached" } });
      assert.equal((await get(app, `/api/me/tickets/${ref}`, customer.session)).json().ticket.messages.length, TICKET_MESSAGES_MAX);
    } finally {
      await app.close();
    }
  });
});
