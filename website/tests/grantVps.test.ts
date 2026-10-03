import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
import { bindAdminGrantDelivery, bindAdminServiceDelivery, openAdminGrant } from "../app/lib/admin-services-api.ts";
// @ts-ignore TS5097
import { PaymentApiError } from "../app/lib/payment-api.ts";
// @ts-ignore TS5097
import { en } from "../app/i18n/en.ts";
// @ts-ignore TS5097
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;

function captureFetch(response: unknown, status = 200) {
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const GRANT = {
  id: 7,
  userId: 3,
  label: "Gift",
  startsAt: "2026-10-01T00:00:00.000Z",
  endsAt: null,
  status: "active",
  reason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  typeId: "local-isp",
  regionId: "us",
  ispId: "us-verizon",
  specId: null,
  durationId: "month-1",
  months: 3,
  valueFen: 23_700,
  deliveryStatus: "open",
  openedAt: "2026-10-02T00:00:00.000Z",
  deliveryLines: [
    { position: 1, label: "Tokyo line", monitorTargetKey: "Tokyo Transit A" },
    { position: 2, label: "Plain line", monitorTargetKey: null },
  ],
};

test("gift opening sends a VPS only for bound lines and parses the bindings back", async () => {
  const stub = captureFetch(GRANT);
  try {
    const grant = await openAdminGrant(7, [
      { label: "Tokyo line", subscriptionUrl: "https://sub.example.invalid/a", monitorTargetKey: "Tokyo Transit A" },
      { label: "Plain line", subscriptionUrl: "https://sub.example.invalid/b", monitorTargetKey: null },
      { label: "Legacy line", subscriptionUrl: "https://sub.example.invalid/c" },
    ], "csrf");
    assert.equal(stub.calls[0]?.url, "/api/admin/grants/7/open");
    assert.deepEqual(stub.calls[0]?.body, {
      items: [
        { label: "Tokyo line", subscriptionUrl: "https://sub.example.invalid/a", monitorTargetKey: "Tokyo Transit A" },
        { label: "Plain line", subscriptionUrl: "https://sub.example.invalid/b" },
        { label: "Legacy line", subscriptionUrl: "https://sub.example.invalid/c" },
      ],
    });
    assert.deepEqual(grant.deliveryLines.map((line) => line.monitorTargetKey), ["Tokyo Transit A", null]);
  } finally {
    stub.restore();
  }
});

test("bind, rebind and unbind send exactly {monitorTargetKey} to the line endpoint", async () => {
  const grantStub = captureFetch(GRANT);
  try {
    await bindAdminGrantDelivery(7, 2, "DMIT Premium", "csrf");
    await bindAdminGrantDelivery(7, 1, null, "csrf");
    assert.deepEqual(grantStub.calls.map((call) => [call.url, call.method, call.body]), [
      ["/api/admin/grants/7/delivery/2", "PATCH", { monitorTargetKey: "DMIT Premium" }],
      ["/api/admin/grants/7/delivery/1", "PATCH", { monitorTargetKey: null }],
    ]);
  } finally {
    grantStub.restore();
  }
  const errorStub = captureFetch({ error: { code: "monitor_unavailable" } }, 503);
  try {
    await assert.rejects(
      () => bindAdminServiceDelivery(11, 1, "DMIT Premium", "csrf"),
      (error) => error instanceof PaymentApiError && error.code === "monitor_unavailable",
    );
    assert.deepEqual(errorStub.calls[0]?.body, { monitorTargetKey: "DMIT Premium" });
  } finally {
    errorStub.restore();
  }
});

test("gift lines without a binding field are rejected as an invalid response", async () => {
  const stub = captureFetch({ ...GRANT, deliveryLines: [{ position: 1, label: "Line" }] });
  try {
    await assert.rejects(
      () => bindAdminGrantDelivery(7, 1, null, "csrf"),
      (error) => error instanceof PaymentApiError && error.code === "invalid_response",
    );
  } finally {
    stub.restore();
  }
});

test("rebind / unbind and gift VPS copy is bilingual", () => {
  assert.deepEqual(Object.keys(en.adminDelivery).sort(), Object.keys(zh.adminDelivery).sort());
  for (const [key, value] of Object.entries(en.adminDelivery)) {
    if (typeof value === "string") assert.doesNotMatch(value, CJK, key);
  }
  assert.equal(zh.adminDelivery.rebindVps, "换绑 VPS");
  assert.equal(zh.adminDelivery.unbindVps, "解除绑定");
  assert.equal(zh.adminDelivery.vpsServer, "对应 VPS 线路服务器");
  assert.doesNotMatch(en.adminDelivery.unbindConfirm("Line"), CJK);
});

test("line-name-follows-VPS hint is bilingual (NSP-LINE-NAME-10)", () => {
  assert.match(zh.adminDelivery.nameFollowsVps, /VPS/);
  assert.doesNotMatch(en.adminDelivery.nameFollowsVps, CJK);
});
