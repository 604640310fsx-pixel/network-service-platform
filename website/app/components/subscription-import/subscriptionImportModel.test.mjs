import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBSCRIPTION_CLIENTS,
  clientsForPlatform,
  safeSubscriptionHref,
  safeVerifiedDeepLinkHref,
} from "./subscriptionImportModel.ts";

// 演示数据 · 非报价；.invalid 为保留域名，不是真实订阅地址。
const DEMO_SUBSCRIPTION_URL = "https://subscription.example.invalid/demo";

test("the frozen client catalog is complete and unique", () => {
  assert.deepEqual(
    SUBSCRIPTION_CLIENTS.map((client) => client.name),
    [
      "Shadowrocket",
      "SingBox",
      "Loon",
      "Quantumult X",
      "Stash",
      "Surge",
      "Clash",
      "Surfboard",
      "FlClash",
      "ClashX",
    ],
  );
  assert.equal(new Set(SUBSCRIPTION_CLIENTS.map((client) => client.id)).size, 10);
});

test("every supported platform has a manual-import client list", () => {
  assert.deepEqual(clientsForPlatform("ios").map((client) => client.name), [
    "Shadowrocket", "SingBox", "Loon", "Quantumult X", "Stash", "Surge",
  ]);
  assert.deepEqual(clientsForPlatform("android").map((client) => client.name), [
    "SingBox", "Clash", "Surfboard", "FlClash",
  ]);
  assert.deepEqual(clientsForPlatform("macos").map((client) => client.name), [
    "SingBox", "Stash", "Surge", "Clash", "FlClash", "ClashX",
  ]);
  assert.deepEqual(clientsForPlatform("windows").map((client) => client.name), [
    "SingBox", "Clash", "FlClash",
  ]);
});

test("subscription actions fail closed unless the value is exact credential-free HTTPS", () => {
  assert.equal(safeSubscriptionHref(DEMO_SUBSCRIPTION_URL), DEMO_SUBSCRIPTION_URL);
  assert.equal(safeSubscriptionHref("http://subscription.example.invalid/demo"), null);
  assert.equal(safeSubscriptionHref("https://user:pass@subscription.example.invalid/demo"), null);
  assert.equal(safeSubscriptionHref(` ${DEMO_SUBSCRIPTION_URL}`), null);
  assert.equal(safeSubscriptionHref("not-a-url"), null);
});

test("only caller-supplied non-web deep links can reach the client action", () => {
  assert.equal(safeVerifiedDeepLinkHref("verified-client://import?id=demo"), "verified-client://import?id=demo");
  assert.equal(safeVerifiedDeepLinkHref(DEMO_SUBSCRIPTION_URL), null);
  assert.equal(safeVerifiedDeepLinkHref("javascript:alert(1)"), null);
  assert.equal(safeVerifiedDeepLinkHref("data:text/plain,demo"), null);
  assert.equal(safeVerifiedDeepLinkHref("file:///tmp/demo"), null);
  assert.equal(safeVerifiedDeepLinkHref("mailto:support@example.invalid"), null);
  assert.equal(safeVerifiedDeepLinkHref("tel:+10000000000"), null);
  assert.equal(safeVerifiedDeepLinkHref(" verified-client://import?id=demo"), null);
  assert.equal(safeVerifiedDeepLinkHref(null), null);
});
