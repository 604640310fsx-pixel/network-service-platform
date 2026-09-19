import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SUBSCRIPTION_CLIENTS,
  SUBSCRIPTION_PLATFORMS,
  clientManualImportReason,
  clientsForPlatform,
  safeSubscriptionHref,
  safeVerifiedDeepLinkHref,
  verifiedSubscriptionDeepLink,
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

test("documented remote URL actions keep the exact synthetic subscription URL", () => {
  const subscriptionUrl = "https://subscription.example.invalid/feed?line=2&name=%E6%B5%8B%E8%AF%95#part";
  const link = (platform, clientId) => verifiedSubscriptionDeepLink({
    platform, clientId, subscriptionUrl,
  });
  const shadowrocket = link("ios", "shadowrocket");
  assert.match(shadowrocket, /^shadowrocket:\/\/add\/sub:\/\/[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(shadowrocket.split("sub://")[1], "base64url").toString("utf8"), subscriptionUrl);

  const singBox = new URL(link("ios", "sing-box"));
  assert.equal(singBox.protocol, "sing-box:");
  assert.equal(singBox.host, "import-remote-profile");
  assert.equal(singBox.searchParams.get("url"), subscriptionUrl);
  assert.equal(decodeURIComponent(singBox.hash.slice(1)), "订阅");

  const loon = link("ios", "loon");
  assert.equal(loon, `loon://import?nodelist=${encodeURIComponent(subscriptionUrl)}`);
  assert.equal(link("macos", "loon"), loon);
  assert.equal(new URL(loon).searchParams.get("nodelist"), subscriptionUrl);

  const quantumult = new URL(link("ios", "quantumult-x"));
  assert.equal(quantumult.pathname, "/add-resource");
  assert.deepEqual(JSON.parse(quantumult.searchParams.get("remote-resource")), {
    server_remote: [subscriptionUrl],
  });

  const expectedSchemes = {
    stash: "stash:", surge: "surge:", surfboard: "surfboard:",
    flclash: "flclash:", clashx: "clash:",
  };
  for (const [clientId, scheme] of Object.entries(expectedSchemes)) {
    const platform = clientId === "surfboard" ? "android" : "macos";
    const uri = new URL(link(platform, clientId));
    assert.equal(uri.protocol, scheme);
    assert.equal(uri.searchParams.get("url"), subscriptionUrl);
    assert.equal(
      [uri.host, uri.pathname].filter(Boolean).join(""),
      clientId === "surge" || clientId === "surfboard" ? "/install-config" : "install-config",
    );
    if (clientId === "clashx") assert.equal(uri.searchParams.get("name"), "NSP");
  }
});

test("only catalog-eligible clients get a safe request and Clash stays manual", () => {
  const supportedSchemes = {
    shadowrocket: "shadowrocket:", "sing-box": "sing-box:", loon: "loon:",
    "quantumult-x": "quantumult-x:", stash: "stash:", surge: "surge:",
    surfboard: "surfboard:", flclash: "flclash:", clashx: "clash:",
  };
  for (const platform of ["ios", "android", "macos", "windows"]) {
    for (const client of clientsForPlatform(platform)) {
      const href = verifiedSubscriptionDeepLink({
        platform, clientId: client.id, subscriptionUrl: DEMO_SUBSCRIPTION_URL,
      });
      if (client.id === "clash") {
        assert.equal(href, null);
      } else {
        assert.equal(new URL(href).protocol, supportedSchemes[client.id]);
        assert.equal(safeVerifiedDeepLinkHref(href), href);
      }
      assert.ok(clientManualImportReason(client.id).length > 0);
    }
  }
  assert.equal(verifiedSubscriptionDeepLink({
    platform: "android", clientId: "loon", subscriptionUrl: DEMO_SUBSCRIPTION_URL,
  }), null);
  for (const clientId of ["shadowrocket", "sing-box", "loon", "quantumult-x", "stash", "surge"]) {
    for (const subscriptionUrl of [
      "http://subscription.example.invalid/feed",
      "https://user:demo@subscription.example.invalid/feed",
    ]) {
      assert.equal(verifiedSubscriptionDeepLink({ platform: "ios", clientId, subscriptionUrl }), null);
    }
  }
});

test("location guidance covers frozen Chrome cases without a fake chrome settings link", () => {
  assert.match(COMPONENT_SOURCE, /chrome:\/\/settings\/content\/location/);
  assert.match(COMPONENT_SOURCE, /检查并清理已允许查看位置的网站名单/);
  assert.match(COMPONENT_SOURCE, /Android：同时检查 Chrome 的网站位置权限与系统中的 Chrome 位置权限，建议设为每次询问或拒绝/);
  assert.match(COMPONENT_SOURCE, /iPhone \/ iPad：在系统设置的定位服务中检查 Chrome 位置权限，建议设为永不或下次询问，并按需拒绝/);
  assert.match(COMPONENT_SOURCE, /非必要时建议关闭；需要时改为每次询问/);
  assert.doesNotMatch(COMPONENT_SOURCE, /href=[^>]*chrome:\/\//);
});

test("the subscription controls follow the approved card order", () => {
  const orderedMarkers = [
    'className="cc-si-location-note"',
    "<span>当前订阅地址</span>",
    'className="cc-si-actions"',
    'className="cc-si-qr"',
    'className="cc-si-platform-tabs"',
    'className="cc-si-client-grid"',
    'className="cc-si-manual"',
    'className="cc-si-help"',
  ];
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const currentIndex = COMPONENT_SOURCE.indexOf(marker);
    assert.ok(currentIndex > previousIndex, `${marker} must follow the previous section`);
    previousIndex = currentIndex;
  }
  assert.match(COMPONENT_SOURCE, /aria-controls=\{qrPanelId\}/);
  assert.match(COMPONENT_SOURCE, /id=\{qrPanelId\} className="cc-si-qr"/);
});

test("client copy describes display choices without claiming verified compatibility", () => {
  assert.match(COMPONENT_SOURCE, /可选客户端/);
  assert.match(COMPONENT_SOURCE, /能否添加由客户端决定/);
  assert.match(COMPONENT_SOURCE, /className="cc-si-client-import"/);
  assert.match(COMPONENT_SOURCE, /onClick=\{\(\) => setActionMessage\(/);
  assert.doesNotMatch(COMPONENT_SOURCE, /已核验客户端/);
});

test("the module is embeddable and responds to its container instead of the viewport", () => {
  assert.doesNotMatch(COMPONENT_SOURCE, /<main\b/);
  assert.equal(
    (COMPONENT_SOURCE.match(/<section className=\{pageClassName\} aria-labelledby=/g) ?? []).length,
    3,
  );
  assert.match(
    COMPONENT_SOURCE,
    /aria-labelledby=\{`\$\{instanceId\}-empty-title`\}[\s\S]*?<h2 id=\{`\$\{instanceId\}-empty-title`\}>/,
  );
  assert.match(
    COMPONENT_SOURCE,
    /aria-labelledby=\{`\$\{instanceId\}-invalid-title`\}[\s\S]*?<h2 id=\{`\$\{instanceId\}-invalid-title`\}>/,
  );
  assert.match(
    COMPONENT_SOURCE,
    /aria-labelledby=\{`\$\{instanceId\}-title`\}[\s\S]*?<h2 id=\{`\$\{instanceId\}-title`\}>/,
  );
  assert.match(COMPONENT_CSS, /repeat\(auto-fit, minmax\(min\(100%, 420px\), 1fr\)\)/);
  assert.match(COMPONENT_SOURCE, /const \[qrOpen, setQrOpen\] = useState\(false\)/);
  assert.match(COMPONENT_CSS, /\.cc-si-page\.is-compact \.cc-si-layout/);
});
