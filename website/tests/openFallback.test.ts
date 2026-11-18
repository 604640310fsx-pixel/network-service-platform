import test from "node:test";
import assert from "node:assert/strict";
import { openAdminService, PaymentApiError } from "../app/lib/payment-api.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;

function captureFetch(response: unknown) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(response), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const OPENED_UNBOUND = {
  id: 11,
  status: "open",
  openedAt: "2026-10-03T00:00:00.000Z",
  items: [{ position: 1, label: "Line A", monitorTargetKey: null }],
};

test("unbound open sends allowUnbound and lines without a VPS, and accepts null targets back", async () => {
  const fetchStub = captureFetch(OPENED_UNBOUND);
  try {
    const result = await openAdminService(
      11,
      "csrf",
      [{ label: " Line A ", subscriptionUrl: "https://sub.example.invalid/a", monitorTargetKey: "" }],
      { allowUnbound: true },
    );
    assert.deepEqual(fetchStub.calls[0]?.body, {
      allowUnbound: true,
      items: [{ label: "Line A", subscriptionUrl: "https://sub.example.invalid/a" }],
    });
    assert.equal(result.items[0]?.monitorTargetKey, null);
  } finally {
    fetchStub.restore();
  }
});

test("normal open still requires a VPS on every line and never sends allowUnbound", async () => {
  const fetchStub = captureFetch({ ...OPENED_UNBOUND, items: [{ position: 1, label: "Line A", monitorTargetKey: "DMIT Premium" }] });
  try {
    await assert.rejects(
      () => openAdminService(11, "csrf", [{ label: "Line A", subscriptionUrl: "https://sub.example.invalid/a", monitorTargetKey: "" }]),
      (error) => error instanceof PaymentApiError && error.code === "invalid_item",
    );
    assert.equal(fetchStub.calls.length, 0, "nothing is sent without a VPS unless the admin confirmed");
    await openAdminService(11, "csrf", [{ label: "Line A", subscriptionUrl: "https://sub.example.invalid/a", monitorTargetKey: "DMIT Premium" }]);
    assert.deepEqual(fetchStub.calls[0]?.body, {
      items: [{ label: "Line A", subscriptionUrl: "https://sub.example.invalid/a", monitorTargetKey: "DMIT Premium" }],
    });
  } finally {
    fetchStub.restore();
  }
});

test("unbound open still rejects non-https URLs before sending", async () => {
  const fetchStub = captureFetch(OPENED_UNBOUND);
  try {
    await assert.rejects(
      () => openAdminService(11, "csrf", [{ label: "A", subscriptionUrl: "http://sub.example.invalid/a", monitorTargetKey: "" }], { allowUnbound: true }),
      (error) => error instanceof PaymentApiError && error.code === "invalid_item",
    );
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
});

test("open-fallback and bind copy is bilingual", () => {
  assert.deepEqual(Object.keys(en.adminDelivery).sort(), Object.keys(zh.adminDelivery).sort());
  for (const [key, value] of Object.entries(en.adminDelivery)) {
    if (typeof value === "string") assert.doesNotMatch(value, CJK, key);
  }
  assert.equal(zh.adminDelivery.allowUnbound, "暂不绑定 VPS 开通（可事后补绑）");
  assert.equal(en.adminDelivery.bound("DMIT Premium"), "Bound to DMIT Premium");
  assert.equal(zh.adminDelivery.unbound, "未绑定 VPS");
  assert.ok(en.adminServices.errors.invalid_monitor_target && zh.adminServices.errors.monitor_unavailable);
});
