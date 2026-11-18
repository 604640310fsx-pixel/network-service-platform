import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// The referral center's interface copy lives in the zh dictionary: centre copy runs from
// `referral: {` up to the shared withdraw/dialog strings, which run up to `records: {`.
function referralCopySlices(read: (path: string) => string) {
  const zh = read("../app/i18n/zh.ts");
  const start = zh.indexOf("  referral: {");
  const parts = zh.indexOf("    withdrawTitlePending:", start);
  const records = zh.indexOf("    records: {", start);
  return { center: zh.slice(start, parts), parts: zh.slice(parts, records), records: zh.slice(records, zh.indexOf("\n  },\n", records)) };
}

import {
  ReferralPublicApiError,
  parseReferralPublicResolution,
  referralCodeFromSearch,
  resolvePublicReferral,
} from "../app/lib/referral-public-api.ts";
import {
  referralSourceCodeFromSearch,
  startRegistration,
} from "../app/lib/registration-api.ts";

test("public response parser exposes only the validity class", () => {
  assert.deepEqual(parseReferralPublicResolution({ valid: true }), { valid: true });
  assert.deepEqual(parseReferralPublicResolution({ valid: false }), { valid: false });
  for (const value of [
    {},
    { valid: "true" },
    { valid: false, publicCode: "A".repeat(24) },
    { valid: true, email: "private@example.test" },
  ]) {
    assert.throws(
      () => parseReferralPublicResolution(value),
      (error: unknown) =>
        error instanceof ReferralPublicApiError && error.code === "invalid_response",
    );
  }
});

test("landing search accepts one code parameter and rejects ambiguous query data", () => {
  assert.equal(referralCodeFromSearch(`?code=${"A".repeat(24)}`), "A".repeat(24));
  assert.equal(referralCodeFromSearch("?code=short"), "short");
  assert.equal(referralCodeFromSearch(""), null);
  assert.equal(referralCodeFromSearch("?next=https%3A%2F%2Fattacker.example"), null);
  assert.equal(referralCodeFromSearch("?code=A&code=B"), null);
  assert.equal(referralCodeFromSearch("?code=A&next=B"), null);
});

test("public client omits credentials and sends no redirect target or tracking data", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ readonly input: string; readonly init: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(typeof input, "string");
    calls.push({ input: input as string, init: init ?? {} });
    return new Response(JSON.stringify({ valid: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await resolvePublicReferral("A".repeat(24));
    await resolvePublicReferral(null);
    assert.equal(calls[0]?.input, `/api/public/referral?code=${"A".repeat(24)}`);
    assert.equal(calls[1]?.input, "/api/public/referral");
    for (const call of calls) {
      assert.equal(call.init.method, "GET");
      assert.equal(call.init.credentials, "omit");
      assert.equal(call.init.cache, "no-store");
      assert.equal(call.init.referrerPolicy, "no-referrer");
      assert.equal(call.init.body, undefined);
      assert.equal(call.input.includes("next="), false);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("landing keeps registration closed and does not claim attribution", () => {
  const landing = readFileSync(
    new URL("../app/components/referral-public/ReferralLandingPage.tsx", import.meta.url),
    "utf8",
  );
  const client = readFileSync(
    new URL("../app/lib/referral-public-api.ts", import.meta.url),
    "utf8",
  );
  const registration = readFileSync(
    new URL("../app/components/auth/RegisterPage.tsx", import.meta.url),
    "utf8",
  );
  assert.match(landing, /<p>\{copy\.policy\}<\/p>/);
  {
    const zhCopy = readFileSync(new URL("../app/i18n/zh.ts", import.meta.url), "utf8");
    const landingCopy = zhCopy.slice(zhCopy.indexOf("  referralLanding: {"), zhCopy.indexOf("\n  },\n", zhCopy.indexOf("  referralLanding: {")));
    assert.match(landingCopy, /当前仅开放邀请注册/);
    assert.match(landingCopy, /不代表推荐归属或佣金资格/);
    assert.match(landingCopy, /管理员签发、绑定邮箱的一次性邀请码，或已注册用户分享的个人邀请码/);
    assert.match(landingCopy, /推荐链接中的代码同时是分享者的个人邀请码，只能用于注册，不能登录任何账户/);
    assert.doesNotMatch(landingCopy, /注册暂未开放|推荐链接不包含邀请码|获取邀请码|申请邀请码|即将开放|预计开放/);
  }
  assert.doesNotMatch(landing, /注册暂未开放/);
  assert.doesNotMatch(landing, /href=\{`\/register\?referralCode=/);
  assert.doesNotMatch(landing, /推荐链接不包含邀请码/);
  assert.doesNotMatch(landing, /获取邀请码|申请邀请码|即将开放|预计开放/);
  assert.match(registration, /name="inviteCode"/);
  assert.match(registration, /startRegistration\([\s\S]*canonicalInvite/);
  assert.match(registration, /referralSourceCodeFromSearch\(window\.location\.search\)/);
  for (const source of [landing, client]) {
    assert.equal(source.includes("localStorage"), false);
    assert.equal(source.includes("sessionStorage"), false);
    assert.equal(source.includes("document.cookie"), false);
    assert.equal(source.includes("navigator.sendBeacon"), false);
    assert.equal(source.includes("referrer_user_id"), false);
  }
});

test("formal referral center states closed actions and leaves withdrawal disabled", () => {
  const center = referralCopySlices((path) => readFileSync(new URL(path, import.meta.url), "utf8")).center;
  const parts = readFileSync(
    new URL("../app/components/referrals/referralParts.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(center, /注册暂未开放/);
  assert.match(center, /当前仅开放邀请注册。推荐链接中的代码也是你的个人邀请码，只能用于注册，不能登录你的账户/);
  assert.doesNotMatch(center, /推荐链接不包含邀请码/);
  assert.doesNotMatch(center, /获取邀请码|申请邀请码|开放注册|自助注册/);
  assert.match(center, /提现门槛：已结算余额满 ¥1,000.00（功能开放后适用）/);
  assert.match(center, /提现功能暂未开放/);
  assert.doesNotMatch(center, /才具备申请提现资格|可申请提现|进入现有注册流程/);
  assert.match(parts, /className="rfc-quiet-btn" disabled aria-disabled="true"/);
});

test("registration query accepts exactly one opaque code", () => {
  const code = "R".repeat(24);
  assert.equal(referralSourceCodeFromSearch(`?referralCode=${code}`), code);
  for (const search of [
    "",
    "?referralCode=short",
    `?referralCode=${code}&referralCode=${code}`,
    `?referralCode=${code}&email=private%40example.test`,
    `?referralCode=${code}&referrer_user_id=1`,
  ]) {
    assert.equal(referralSourceCodeFromSearch(search), null);
  }
});

test("registration start sends the invite unchanged and no browser identity", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ readonly url: string; readonly body: unknown }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({
      url: String(input),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(
      JSON.stringify({ status: "ok", registrationToken: `v2.${"A".repeat(43)}` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };
  try {
    const email = "invitee@example.test";
    const inviteCode = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567";
    const referralCode = "R".repeat(24);
    await startRegistration(email, inviteCode, referralCode);
    await startRegistration(email, inviteCode);
    assert.deepEqual(requests, [
      {
        url: "/api/auth/register/start",
        body: { email, inviteCode, referralCode },
      },
      {
        url: "/api/auth/register/start",
        body: { email, inviteCode },
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
