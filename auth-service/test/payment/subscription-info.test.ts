import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { buildApp } from "../../src/app.js";
import type { DatabaseConnection } from "../../src/db.js";
import { createPaymentOrder } from "../../src/payment/orders.js";
import { finalizePaid } from "../../src/payment/state-machine.js";
import {
  isBlockedAddress,
  nodeSubscriptionHeaderFetcher,
  parseSubscriptionUserinfo,
  readSubscriptionInfo,
  SubscriptionInfoCache,
  type SubscriptionHeaderFetcher,
} from "../../src/subscription/userinfo.js";
import { insertAuthenticationUser, withAuthenticationDatabase } from "../auth/helpers.js";
import {
  ACCESS_TOKEN_A,
  DELIVERY_KEYRING,
  firstValue,
  insertWebSession,
  localIspSelection,
  paymentDependencies,
  TEST_NOW,
  TOKEN_KEYRING,
} from "./helpers.js";

/* NSP-SUB-TRAFFIC-09：订阅 URL 代取 subscription-userinfo。 */

const SERVICE_URL = "https://sub.example.invalid/service?token=demo-secret-s";
const GIFT_URL = "https://sub.example.invalid/gift?token=demo-secret-g";

test("userinfo parsing: full, partial, malformed and absent headers", () => {
  assert.deepEqual(parseSubscriptionUserinfo("upload=1024; download=2048; total=10737418240; expire=1767225600"), {
    upload: 1024, download: 2048, total: 10_737_418_240, expire: 1_767_225_600,
  });
  assert.deepEqual(parseSubscriptionUserinfo("Upload=5,Download=6"), { upload: 5, download: 6, total: null, expire: null });
  assert.deepEqual(parseSubscriptionUserinfo("upload=1; download=x; total=-3; expire=0"), { upload: 1, download: null, total: null, expire: null });
  assert.deepEqual(parseSubscriptionUserinfo("upload=99999999999999999999"), { upload: null, download: null, total: null, expire: null });
  for (const value of [null, undefined, "", "foo=1; bar=2", "garbage", "x".repeat(2000)]) {
    assert.equal(parseSubscriptionUserinfo(value), null, String(value).slice(0, 20));
  }
});

test("blocked addresses cover loopback, private, link-local, CGNAT and mapped forms", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "not-an-ip"]) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "203.0.113.10", "2606:4700::1111"]) {
    assert.equal(isBlockedAddress(address), false, address);
  }
});

test("the real fetcher refuses a loopback target before connecting", async (context) => {
  let hits = 0;
  const server = createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { "subscription-userinfo": "upload=1; download=2; total=3" });
    response.end("body");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const port = (server.address() as AddressInfo).port;
  for (const url of [`http://127.0.0.1:${port}/x`, `http://localhost:${port}/x`, `http://[::1]:${port}/x`]) {
    const result = await readSubscriptionInfo(url, nodeSubscriptionHeaderFetcher, 2_000);
    assert.deepEqual(result, { info: null, reason: "unreachable" }, url);
  }
  assert.equal(hits, 0, "no request reached the loopback server");
});

test("reads only 2xx headers; redirects, errors, timeouts and bad schemes are unreachable", async () => {
  const fixed = (status: number, userinfo: string | null): SubscriptionHeaderFetcher => async () => ({ status, userinfo });
  assert.deepEqual(await readSubscriptionInfo(SERVICE_URL, fixed(200, "upload=1; download=2; total=10; expire=0")), {
    info: { upload: 1, download: 2, total: 10, expire: null },
  });
  assert.deepEqual(await readSubscriptionInfo(SERVICE_URL, fixed(200, null)), { info: null, reason: "no_userinfo" });
  assert.deepEqual(await readSubscriptionInfo(SERVICE_URL, fixed(200, "nothing=1")), { info: null, reason: "no_userinfo" });
  for (const status of [301, 302, 307, 403, 500]) {
    assert.deepEqual(await readSubscriptionInfo(SERVICE_URL, fixed(status, "upload=1")), { info: null, reason: "unreachable" }, String(status));
  }
  assert.deepEqual(await readSubscriptionInfo(SERVICE_URL, async () => { throw new Error("ECONNRESET"); }), { info: null, reason: "unreachable" });
  const hanging: SubscriptionHeaderFetcher = (_url, signal) =>
    new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("timeout"))));
  // AbortSignal.timeout timers are unref'd; keep the test's event loop alive until it fires.
  const keepAlive = setTimeout(() => undefined, 1_000);
  assert.deepEqual(await readSubscriptionInfo(SERVICE_URL, hanging, 50), { info: null, reason: "unreachable" });
  clearTimeout(keepAlive);
  let called = false;
  const spy: SubscriptionHeaderFetcher = async () => { called = true; return { status: 200, userinfo: "upload=1" }; };
  for (const url of ["ftp://sub.example.invalid/x", "file:///etc/passwd", "not a url"]) {
    assert.deepEqual(await readSubscriptionInfo(url, spy), { info: null, reason: "unreachable" }, url);
  }
  assert.equal(called, false);
});

test("cache keeps results 60s and failures 15s", () => {
  const cache = new SubscriptionInfoCache();
  cache.set("ok", { info: { upload: 1, download: 1, total: 2, expire: null } }, 0);
  cache.set("down", { info: null, reason: "unreachable" }, 0);
  assert.notEqual(cache.get("ok", 59_999), null);
  assert.equal(cache.get("ok", 60_000), null);
  assert.notEqual(cache.get("down", 14_999), null);
  assert.equal(cache.get("down", 15_000), null);
});

async function withFixture(
  run: (fixture: {
    readonly database: DatabaseConnection;
    readonly app: ReturnType<typeof buildApp>;
    readonly buyer: ReturnType<typeof insertWebSession>;
    readonly other: ReturnType<typeof insertWebSession>;
    readonly admin: ReturnType<typeof insertWebSession>;
    readonly orderRef: string;
    readonly grantId: number;
    readonly calls: string[];
    setUserinfo(value: string | null): void;
  }) => Promise<void>,
): Promise<void> {
  await withAuthenticationDatabase(async (database) => {
    const buyerId = insertAuthenticationUser(database, { email: "traffic-buyer@example.com", passwordHash: "hash", status: "active" });
    const otherId = insertAuthenticationUser(database, { email: "traffic-other@example.com", passwordHash: "hash", status: "active" });
    const adminId = insertAuthenticationUser(database, { email: "traffic-admin@example.com", passwordHash: "hash", status: "active", role: "admin" });
    const payment = paymentDependencies(database);
    const order = createPaymentOrder(payment, {
      idempotencyKey: "traffic-order",
      rawAccessToken: ACCESS_TOKEN_A,
      selection: localIspSelection(),
      contact: "c",
      scenarios: [],
      notes: null,
      acknowledgedAmountFen: 7_900,
      userId: buyerId,
    });
    finalizePaid(payment, {
      outTradeNo: order.orderRef,
      tradeNo: "trade-traffic",
      tradeStatus: "TRADE_SUCCESS",
      totalAmount: "79.00",
      totalAmountFen: 7_900,
      appId: "app-123",
      sellerId: "seller-456",
      notification: { notifyId: "n-traffic", payloadHash: "h-traffic" },
    });
    const serviceId = firstValue(database, "SELECT MAX(id) FROM services") as number;
    const calls: string[] = [];
    let userinfo: string | null = "upload=1073741824; download=2147483648; total=10737418240; expire=1767225600";
    const app = buildApp({
      payment,
      subscriptionInfo: {
        database,
        tokenHmacKeyring: TOKEN_KEYRING,
        rateLimitKeyring: TOKEN_KEYRING,
        deliveryEncKeyring: DELIVERY_KEYRING,
        fetcher: async (url) => { calls.push(url.toString()); return { status: 200, userinfo }; },
        now: () => new Date(TEST_NOW),
      },
    });
    const admin = insertWebSession(database, adminId);
    const headers = { cookie: admin.cookie, "content-type": "application/json", "x-csrf-token": admin.csrfToken };
    try {
      const opened = await app.inject({
        method: "POST", url: `/api/admin/services/${serviceId}/open`, headers,
        payload: { items: [{ label: "Line A", subscriptionUrl: SERVICE_URL, monitorTargetKey: "DMIT Premium" }] },
      });
      assert.equal(opened.statusCode, 200, opened.body);
      const grant = await app.inject({
        method: "POST", url: "/api/admin/grants", headers,
        payload: { userId: buyerId, typeId: "local-isp", regionId: "us", ispId: "us-verizon", durationId: "month-1", months: 1, valueFen: 7_900 },
      });
      const grantId = grant.json().id as number;
      const giftOpen = await app.inject({
        method: "POST", url: `/api/admin/grants/${grantId}/open`, headers,
        payload: { items: [{ label: "Gift A", subscriptionUrl: GIFT_URL }] },
      });
      assert.equal(giftOpen.statusCode, 200, giftOpen.body);
      await run({
        database, app, admin,
        buyer: insertWebSession(database, buyerId),
        other: insertWebSession(database, otherId),
        orderRef: order.orderRef, grantId, calls,
        setUserinfo(value) { userinfo = value; },
      });
    } finally {
      await app.close();
    }
  });
}

test("subscription-info returns parsed usage for owned service and gift lines without leaking the URL", async () => {
  await withFixture(async ({ app, buyer, orderRef, grantId, calls }) => {
    const get = (query: string) => app.inject({ method: "GET", url: `/api/me/subscription-info${query}`, headers: { cookie: buyer.cookie } });
    const service = await get(`?line=service:${orderRef}:1`);
    assert.equal(service.statusCode, 200, service.body);
    assert.equal(service.headers["cache-control"], "no-store");
    assert.deepEqual(service.json(), { info: { upload: 1_073_741_824, download: 2_147_483_648, total: 10_737_418_240, expire: 1_767_225_600 } });
    const gift = await get(`?line=grant:${grantId}:1`);
    assert.equal(gift.statusCode, 200, gift.body);
    assert.deepEqual(calls, [SERVICE_URL, GIFT_URL], "the decrypted URLs are only used server-side");
    for (const body of [service.body, gift.body]) {
      assert.equal(body.includes("sub.example.invalid"), false);
      assert.equal(body.includes("demo-secret"), false);
    }
  });
});

test("subscription-info caches per line, and reports no_userinfo without erroring", async () => {
  await withFixture(async ({ app, buyer, orderRef, grantId, calls, setUserinfo }) => {
    const get = (query: string) => app.inject({ method: "GET", url: `/api/me/subscription-info${query}`, headers: { cookie: buyer.cookie } });
    await get(`?line=service:${orderRef}:1`);
    await get(`?line=service:${orderRef}:1`);
    assert.equal(calls.length, 1, "second read within 60s is served from the cache");
    setUserinfo(null);
    const none = await get(`?line=grant:${grantId}:1`);
    assert.equal(none.statusCode, 200);
    assert.deepEqual(none.json(), { info: null, reason: "no_userinfo" });
  });
});

test("subscription-info enforces ownership, query shape, session and role", async () => {
  await withFixture(async ({ app, buyer, other, admin, orderRef, grantId, calls }) => {
    const as = (session: { cookie: string } | null, query: string) =>
      app.inject({ method: "GET", url: `/api/me/subscription-info${query}`, headers: session === null ? {} : { cookie: session.cookie } });
    for (const [session, query, status, code] of [
      [other, `?line=service:${orderRef}:1`, 404, "line_not_found"],
      [other, `?line=grant:${grantId}:1`, 404, "line_not_found"],
      [buyer, `?line=service:${orderRef}:2`, 404, "line_not_found"],
      [buyer, "?line=service:DL1:1", 404, "line_not_found"],
      [buyer, "", 400, "invalid_request"],
      [buyer, `?line=service:${orderRef}:1&url=https://evil.example.invalid`, 400, "invalid_request"],
      [buyer, "?target=x", 400, "invalid_request"],
      [null, `?line=service:${orderRef}:1`, 401, "unauthorized"],
      [admin, `?line=service:${orderRef}:1`, 403, "forbidden"],
    ] as const) {
      const response = await as(session, query);
      assert.equal(response.statusCode, status, `${query} ${status}`);
      assert.equal(response.json().error.code, code, query);
    }
    assert.equal(calls.length, 0, "no upstream request for rejected lines");
  });
});

test("subscription-info is closed when unconfigured", async () => {
  const app = buildApp({});
  try {
    const response = await app.inject({ method: "GET", url: "/api/me/subscription-info?line=grant:1:1" });
    assert.equal(response.statusCode, 503);
    assert.equal(response.json().error.code, "subscription_info_unavailable");
  } finally {
    await app.close();
  }
});
