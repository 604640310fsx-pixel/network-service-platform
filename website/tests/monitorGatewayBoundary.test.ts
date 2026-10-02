import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  getAdminMonitorTargets,
  getMyDeliveryLines,
  getPaymentOrder,
  PaymentApiError,
} from "../app/lib/payment-api.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("public monitor uses the dedicated embed view without target identity", () => {
  const page = source("../app/components/monitor/PublicMonitorPage.tsx");
  assert.match(page, /embedded:\s*true/);
  assert.match(page, /referrerPolicy="same-origin"/);
  assert.match(page, /FIXTURE · 15S/);
  assert.match(page, /monitorBannerMode\(/);
  assert.match(page, /\.\.\.copy\.banner\[bannerMode\]/);
  // Banner copy lives in the dictionaries (both languages).
  const zhCopy = source("../app/i18n/zh.ts");
  const enCopy = source("../app/i18n/en.ts");
  assert.match(zhCopy, /fixture: \{[^}]*statusLabel: "本地演示数据"/);
  assert.match(zhCopy, /unconfigured: \{[^}]*statusLabel: "监控未接入"/);
  assert.match(zhCopy, /embed: \{[^}]*statusLabel: "状态待确认"/);
  // URL validation is not gateway health or freshness proof: no mode may claim live data.
  const embedStyle = page.match(/\n  embed:\s*\{[^}]*\}/)?.[0];
  assert.ok(embedStyle, "BANNER_STYLE.embed block must exist");
  assert.doesNotMatch(embedStyle, /LIVE|15S/);
  for (const dictionary of [zhCopy, enCopy]) {
    const monitorCopy = dictionary.slice(dictionary.indexOf("  monitor: {"), dictionary.indexOf("  notFound: {"));
    const embedCopy = monitorCopy.match(/embed: \{[^}]*\}/)?.[0];
    assert.ok(embedCopy, "monitor.banner.embed copy must exist");
    assert.doesNotMatch(embedCopy, /LIVE|实时数据同步|15S|live data/i);
  }
  assert.doesNotMatch(page, /target\s*:/);
  assert.doesNotMatch(page, /广州三网/);
});

test("sidebar mini is identity-free and status navigation carries no fixed target", () => {
  const shell = source("../app/components/customer/CustomerCenterShell.tsx");
  assert.match(shell, /compact:\s*true/);
  assert.match(shell, /to="\/status"/);
  assert.doesNotMatch(shell, /SIDEBAR_MONITOR_TARGET|target\s*:/);
});

test("buyer status uses only the authenticated same-origin projection", () => {
  const page = source("../app/components/status/BuyerServerStatusPage.tsx");
  assert.match(page, /getMonitorStatus\(controller\.signal\)/);
  assert.match(page, /状态由账户授权投影返回/);
  assert.doesNotMatch(page, /<iframe|import\.meta\.env|buildMonitorEmbedUrl\(|useSearchParams\(/);
  assert.doesNotMatch(page, /monitorTargetKey|[?&](?:target|vps)=/);
});

function apiResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("customer payment projections reject monitor target leakage while admin retains keys", async (context) => {
  const originalFetch = globalThis.fetch;
  const responses: Response[] = [];
  globalThis.fetch = (async () => {
    const response = responses.shift();
    if (response === undefined) throw new Error("missing test response");
    return response;
  }) as typeof fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });

  responses.push(apiResponse({
    orderRef: "DLBOUNDARY1",
    status: "paid",
    amountFen: 7900,
    currency: "CNY",
    reservedUntil: null,
    service: {
      status: "open",
      items: [{
        position: 1,
        label: "线路 1",
        subscriptionUrl: "https://subscription.example.test/one",
        monitorTargetKey: "hidden-target",
      }],
    },
  }));
  await assert.rejects(
    getPaymentOrder("DLBOUNDARY1", null),
    (error: unknown) => error instanceof PaymentApiError && error.code === "invalid_response",
  );

  responses.push(apiResponse({
    items: [{
      orderRef: "DLBOUNDARY1",
      position: 1,
      label: "线路 1",
      monitorTargetKey: "hidden-target",
    }],
  }));
  await assert.rejects(
    getMyDeliveryLines(),
    (error: unknown) => error instanceof PaymentApiError && error.code === "invalid_response",
  );

  responses.push(apiResponse({
    items: [{ key: "target-a", label: "Target A", state: "active" }],
  }));
  assert.deepEqual(await getAdminMonitorTargets(), [
    { key: "target-a", label: "Target A", state: "active" },
  ]);
});
