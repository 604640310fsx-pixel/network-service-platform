import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
import { WalletApiError, cancelMyOrder, setAdminNextBillingPeriod, setMyNextBillingPeriod } from "../app/lib/wallet-api.ts";
// @ts-ignore TS5097
import { closeAdminOrder, listAdminOrders } from "../app/lib/admin-orders-api.ts";

type Call = { readonly url: string; readonly init: RequestInit };

async function withFetch<Result>(respond: (call: Call) => { status: number; body: unknown }, run: (calls: Call[]) => Promise<Result>): Promise<Result> {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body } = respond(call);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const CSRF = "c".repeat(43);
const order = {
  id: 7, orderRef: "DLDEMO0000000007", userId: null, status: "paid", paymentStatus: null, amountFen: 5900, currency: "CNY",
  createdAt: "2026-10-04T00:00:00.000Z", serviceId: null, serviceStatus: null, managementClosed: false, refundState: null, serviceStopState: null,
};

test("buyer cancel posts to the orderRef route with CSRF and returns only the server result", async () => {
  await withFetch(() => ({ status: 200, body: { result: "CANCELLED" } }), async (calls) => {
    assert.equal(await cancelMyOrder(CSRF, "DLDEMO0000000001"), "CANCELLED");
    assert.equal(calls[0]?.url, "/api/me/orders/DLDEMO0000000001/cancel");
    assert.equal(calls[0]?.init.method, "POST");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["X-CSRF-Token"], CSRF);
  });
  await withFetch(() => ({ status: 200, body: { result: "ALREADY_CANCELLED" } }), async () => {
    assert.equal(await cancelMyOrder(CSRF, "DLDEMO0000000001"), "ALREADY_CANCELLED");
  });
  await withFetch(() => ({ status: 409, body: { error: { code: "not_cancellable" } } }), async () => {
    await assert.rejects(cancelMyOrder(CSRF, "DLDEMO0000000001"), (error: unknown) => error instanceof WalletApiError && error.code === "not_cancellable" && error.status === 409);
  });
  await withFetch(() => ({ status: 200, body: { result: "MAYBE" } }), async () => {
    await assert.rejects(cancelMyOrder(CSRF, "DLDEMO0000000001"), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_response");
  });
  await withFetch(() => ({ status: 200, body: {} }), async (calls) => {
    await assert.rejects(cancelMyOrder(CSRF, "../admin"), (error: unknown) => error instanceof WalletApiError && error.code === "not_found");
    assert.equal(calls.length, 0);
  });
});

test("next-billing-period PUTs send exactly {period, expectedRevision} to the buyer and admin routes", async () => {
  await withFetch(() => ({ status: 200, body: { revision: 5 } }), async (calls) => {
    assert.equal(await setMyNextBillingPeriod(CSRF, 42, { period: "ANNUAL", expectedRevision: 4 }), 5);
    assert.equal(await setAdminNextBillingPeriod(CSRF, 42, { period: "QUARTERLY", expectedRevision: 5 }), 5);
    assert.deepEqual(calls.map((call) => [call.url, call.init.method]), [
      ["/api/me/services/42/next-billing-period", "PUT"],
      ["/api/admin/services/42/next-billing-period", "PUT"],
    ]);
    assert.deepEqual(JSON.parse(String(calls[0]?.init.body)), { period: "ANNUAL", expectedRevision: 4 });
    assert.deepEqual(JSON.parse(String(calls[1]?.init.body)), { period: "QUARTERLY", expectedRevision: 5 });
  });
  for (const code of ["revision_conflict", "quote_unavailable", "service_closed"]) {
    await withFetch(() => ({ status: 409, body: { error: { code } } }), async () => {
      await assert.rejects(setMyNextBillingPeriod(CSRF, 42, { period: "MONTHLY", expectedRevision: 0 }), (error: unknown) => error instanceof WalletApiError && error.code === code);
    });
  }
  await withFetch(() => ({ status: 200, body: {} }), async (calls) => {
    await assert.rejects(setAdminNextBillingPeriod(CSRF, 0, { period: "MONTHLY", expectedRevision: 0 }), (error: unknown) => error instanceof WalletApiError && error.code === "not_found");
    await assert.rejects(setMyNextBillingPeriod(CSRF, 42, { period: "WEEKLY" as never, expectedRevision: 0 }), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_request");
    assert.equal(calls.length, 0);
  });
});

test("admin orders list keeps a null payment as null, pages by nextBeforeId and never turns a failure into an empty list", async () => {
  await withFetch(() => ({ status: 200, body: { orders: [order], nextBeforeId: 7 } }), async (calls) => {
    const page = await listAdminOrders({ orderRef: " DLDEMO0000000007 ", userId: 3, beforeId: 9 });
    assert.equal(calls[0]?.url, "/api/admin/orders?orderRef=DLDEMO0000000007&userId=3&beforeId=9");
    assert.equal(calls[0]?.init.method, "GET");
    assert.equal(page.orders[0]?.paymentStatus, null);
    assert.equal(page.orders[0]?.userId, null);
    assert.equal(page.nextBeforeId, 7);
  });
  await withFetch(() => ({ status: 503, body: { error: { code: "wallet_unavailable" } } }), async () => {
    await assert.rejects(listAdminOrders(), (error: unknown) => error instanceof WalletApiError && error.code === "wallet_unavailable" && error.status === 503);
  });
  for (const bad of [{ ...order, id: 0 }, { ...order, paymentStatus: "unpaid" }, { ...order, managementClosed: 1 }, { ...order, currency: "USD" }]) {
    await withFetch(() => ({ status: 200, body: { orders: [bad], nextBeforeId: null } }), async () => {
      await assert.rejects(listAdminOrders(), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_response");
    });
  }
  await withFetch(() => ({ status: 200, body: {} }), async (calls) => {
    await assert.rejects(listAdminOrders({ userId: -1 }), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_request");
    assert.equal(calls.length, 0);
  });
});

test("admin close uses the real orders.id and reports pending refund / stop request as recorded, not completed", async () => {
  await withFetch(() => ({ status: 200, body: { orderRef: "DLDEMO0000000007", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: "REQUESTED" } }), async (calls) => {
    const result = await closeAdminOrder(CSRF, 7);
    assert.equal(calls[0]?.url, "/api/admin/orders/7/close");
    assert.equal((calls[0]?.init.headers as Record<string, string>)["X-CSRF-Token"], CSRF);
    assert.deepEqual(result, { orderRef: "DLDEMO0000000007", managementClosed: true, refundState: "AWAITING_POLICY", serviceStopState: "REQUESTED" });
  });
  await withFetch(() => ({ status: 200, body: { orderRef: "DLDEMO0000000007", managementClosed: true, refundState: "REFUNDED", serviceStopState: null } }), async () => {
    await assert.rejects(closeAdminOrder(CSRF, 7), (error: unknown) => error instanceof WalletApiError && error.code === "invalid_response");
  });
  const panel = source("../app/components/dashboard/AdminOrdersPanel.tsx");
  const zh = source("../app/i18n/zh.ts");
  assert.match(panel, /order\.paymentStatus === null \? copy\.noPayment/);
  assert.match(panel, /order\.serviceStopState === "REQUESTED" \? copy\.stopRequested/);
  assert.match(zh, /noPayment: "无支付记录"/);
  assert.match(zh, /stopRequested: "已记录停止请求（尚未实际停止）"/);
  assert.match(zh, /refundAwaiting: "待定退款政策（尚未退款）"/);
});

test("admin renewal is read from the service DTO; admins only change the period and never enable consent", async () => {
  // @ts-ignore TS5097
  const { getAdminUserServices } = await import("../app/lib/admin-services-api.ts");
  const service = { id: 42, orderRef: "DLDEMO0000000042", amountFen: 5900, orderStatus: "paid", serviceStatus: "open", typeId: "t", regionId: "r", ispId: "i", specId: null, durationId: "month-1", createdAt: "x", openedAt: null, endsAt: null, planLabel: null, adminNote: null, deliveryLines: [] };
  await withFetch(() => ({ status: 200, body: { user: { id: 1, email: "a@b.c", role: "user", status: "active", createdAt: "x" }, services: [{ ...service, renewal: { state: "ENABLED", revision: 3, period: "MONTHLY" } }, service], grants: [] } }), async () => {
    const detail = await getAdminUserServices(1);
    assert.deepEqual(detail.services[0].renewal, { state: "ENABLED", revision: 3, period: "MONTHLY" });
    assert.equal(detail.services[1].renewal, null);
  });
  const panel = source("../app/components/dashboard/AdminUserServicesPanel.tsx");
  assert.doesNotMatch(panel, /putRenewalConsent|renewal-consent/);
  assert.match(panel, /setAdminNextBillingPeriod\(csrfToken, service\.id, \{ period: choice, expectedRevision: renewal\.revision \}\)/);
  assert.match(source("../app/components/dashboard/AdminPendingServices.tsx"), /case "service_closed": return "该订单已被管理关闭/);
});
