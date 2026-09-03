import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SUBSCRIPTION_CLIENTS,
  SUBSCRIPTION_PLATFORMS,
  clientsForPlatform,
  safeSubscriptionHref,
  safeVerifiedDeepLinkHref,
} from "./subscriptionImportModel.ts";

// 演示数据 · 非报价；.invalid 为保留域名，不是真实订阅地址。
const DEMO_SUBSCRIPTION_URL = "https://subscription.example.invalid/demo";
const COMPONENT_SOURCE = readFileSync(new URL("./SubscriptionImportModule.tsx", import.meta.url), "utf8");
const COMPONENT_CSS = readFileSync(new URL("./subscription-import.css", import.meta.url), "utf8");

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

test("the frozen platform client order and recommendation marks are exact", () => {
  assert.deepEqual(SUBSCRIPTION_PLATFORMS.map((platform) => platform.label), [
    "iOS", "Android", "macOS", "Windows",
  ]);
  const display = (platform) => clientsForPlatform(platform).map((client) =>
    `${client.name}${client.recommended ? "*" : ""}`
  );
  assert.deepEqual(display("ios"), [
    "Shadowrocket*", "SingBox*", "Loon", "Quantumult X", "Stash", "Surge",
  ]);
  assert.deepEqual(display("android"), [
    "Clash*", "SingBox*", "Surfboard*", "FlClash",
  ]);
  assert.deepEqual(display("macos"), [
    "Clash*", "SingBox*", "ClashX", "FlClash", "Loon", "Stash", "Surge",
  ]);
  assert.deepEqual(display("windows"), ["Clash*", "SingBox*", "FlClash"]);
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

test("location guidance covers frozen Chrome cases without a fake chrome settings link", () => {
  assert.match(COMPONENT_SOURCE, /chrome:\/\/settings\/content\/location/);
  assert.match(COMPONENT_SOURCE, /Android：同时检查 Chrome 的网站位置权限与系统中的 Chrome 位置权限，建议设为每次询问或拒绝/);
  assert.match(COMPONENT_SOURCE, /iPhone \/ iPad：在系统设置的定位服务中检查 Chrome 位置权限，建议设为永不或下次询问，并按需拒绝/);
  assert.match(COMPONENT_SOURCE, /非必要时建议关闭；需要时改为每次询问/);
  assert.doesNotMatch(COMPONENT_SOURCE, /href=[^>]*chrome:\/\//);
});

test("client copy describes display choices without claiming verified compatibility", () => {
  assert.match(COMPONENT_SOURCE, /可选客户端/);
  assert.match(COMPONENT_SOURCE, /一键导入和兼容性仍需逐项确认/);
  assert.doesNotMatch(COMPONENT_SOURCE, /已核验客户端/);
});

test("the module is embeddable and responds to its container instead of the viewport", () => {
  assert.doesNotMatch(COMPONENT_SOURCE, /<main\b/);
  assert.match(COMPONENT_SOURCE, /<section className="cc-si-page" aria-labelledby=/);
  assert.match(COMPONENT_CSS, /repeat\(auto-fit, minmax\(min\(100%, 420px\), 1fr\)\)/);
});
