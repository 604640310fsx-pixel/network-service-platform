import test from "node:test";
import assert from "node:assert/strict";
// @ts-ignore TS5097: node strip-types needs the explicit .ts specifier
import { getSubscriptionInfo, parseSubscriptionInfo } from "../app/lib/subscription-info-api.ts";
// @ts-ignore TS5097
import { PaymentApiError } from "../app/lib/payment-api.ts";
// @ts-ignore TS5097
import { aggregateUsage, formatBytes, usageFacts } from "../app/components/network/trafficUsage.ts";
// @ts-ignore TS5097
import { en } from "../app/i18n/en.ts";
// @ts-ignore TS5097
import { zh } from "../app/i18n/zh.ts";

const CJK = /[㐀-鿿]/;
const GB = 1024 ** 3;

test("subscription info parses usage, no_userinfo and unreachable, and rejects anything else", () => {
  assert.deepEqual(parseSubscriptionInfo({ info: { upload: 1, download: 2, total: 10, expire: null } }), {
    kind: "usage", usage: { upload: 1, download: 2, total: 10, expire: null },
  });
  assert.deepEqual(parseSubscriptionInfo({ info: null, reason: "no_userinfo" }), { kind: "no_userinfo" });
  assert.deepEqual(parseSubscriptionInfo({ info: null, reason: "unreachable" }), { kind: "unreachable" });
  for (const body of [
    {},
    { info: null },
    { info: null, reason: "other" },
    { info: { upload: 1, download: 2, total: 10 } },
    { info: { upload: -1, download: 2, total: 10, expire: null } },
    { info: { upload: 1.5, download: 2, total: 10, expire: null } },
    { info: { upload: 1, download: 2, total: 10, expire: null, url: "https://x" } },
    { info: { upload: 1, download: 2, total: 10, expire: null }, reason: "no_userinfo" },
  ]) {
    assert.throws(() => parseSubscriptionInfo(body), (error) => error instanceof PaymentApiError && error.code === "invalid_response", JSON.stringify(body));
  }
});

test("usage facts: used = upload + download, remaining clamps at 0, missing values stay unknown", () => {
  const facts = usageFacts({ upload: 1 * GB, download: 2 * GB, total: 10 * GB, expire: 1_767_225_600 });
  assert.equal(facts.used, 3 * GB);
  assert.equal(facts.remaining, 7 * GB);
  assert.equal(facts.ratio, 0.3);
  assert.equal(facts.expireAt?.toISOString(), "2026-01-01T00:00:00.000Z");
  assert.deepEqual(usageFacts({ upload: 12 * GB, download: 0, total: 10 * GB, expire: null }).remaining, 0);
  const partial = usageFacts({ upload: null, download: null, total: 10 * GB, expire: null });
  assert.deepEqual([partial.used, partial.remaining, partial.ratio, partial.expireAt], [null, null, null, null]);
  assert.equal(usageFacts({ upload: 5, download: null, total: 0, expire: null }).total, null, "total 0 means not provided");
  assert.deepEqual(aggregateUsage([facts, partial, usageFacts({ upload: 1, download: 1, total: null, expire: null })]), {
    used: 3 * GB + 2, remaining: 7 * GB, lines: 2,
  });
  assert.deepEqual(aggregateUsage([]), { used: null, remaining: null, lines: 0 });
});

test("bytes use binary units", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.50 KB");
  assert.equal(formatBytes(3 * GB), "3.00 GB");
  assert.equal(formatBytes(150.4 * GB), "150 GB");
  assert.equal(formatBytes(2 * 1024 * GB), "2.00 TB");
});

test("the request names the buyer's line only", async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ info: null, reason: "no_userinfo" }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    assert.deepEqual(await getSubscriptionInfo("grant:7:1"), { kind: "no_userinfo" });
    assert.deepEqual(calls, ["/api/me/subscription-info?line=grant%3A7%3A1"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("usage copy is bilingual", () => {
  assert.deepEqual(Object.keys(en.network.usage).sort(), Object.keys(zh.network.usage).sort());
  for (const [key, value] of Object.entries(en.network.usage)) {
    const text = typeof value === "function" ? (value as (arg: never) => string)(2 as never) : value;
    assert.doesNotMatch(String(text), CJK, key);
  }
  assert.equal(zh.network.usage.noUserinfo, "该订阅不提供用量");
  assert.equal(zh.network.usage.resetHint, "重置周期由订阅商策略决定");
});
