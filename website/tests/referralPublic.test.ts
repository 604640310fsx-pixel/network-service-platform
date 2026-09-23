import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ReferralPublicApiError,
  parseReferralPublicResolution,
  referralCodeFromSearch,
  resolvePublicReferral,
} from "../app/lib/referral-public-api.ts";

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

test("landing keeps registration invite-gated and contains no persistence or attribution wiring", () => {
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
  assert.match(landing, /href="\/register"/);
  assert.doesNotMatch(landing, /href="\/register\?/);
  assert.match(landing, /仍需填写有效邀请码/);
  assert.match(registration, /name="inviteCode"/);
  assert.match(registration, /startRegistration\([\s\S]*canonicalInvite/);
  for (const source of [landing, client]) {
    assert.equal(source.includes("localStorage"), false);
    assert.equal(source.includes("sessionStorage"), false);
    assert.equal(source.includes("document.cookie"), false);
    assert.equal(source.includes("navigator.sendBeacon"), false);
    assert.equal(source.includes("/register?"), false);
  }
});
