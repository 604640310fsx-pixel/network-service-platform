import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PASSWORD_MAX_LENGTH,
  REGISTRATION_PASSWORD_MIN_LENGTH,
} from "../app/components/auth/passwordPolicy.ts";
import {
  RESET_DONE_NOTICE,
  RESET_REQUEST_SENT_NOTICE,
  resetConfirmFailure,
  resetRequestErrorMessage,
  validateResetEmail,
  validateResetPassword,
} from "../app/components/auth/passwordResetModel.ts";
import {
  confirmPasswordReset,
  parseOk,
  PasswordResetApiError,
  requestPasswordReset,
  resetTokenFromSearch,
} from "../app/lib/password-reset-api.ts";

const TOKEN = "A".repeat(42) + "b";
const GOOD = "battery-staple-99";
const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

async function withFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  run: (calls: Array<{ url: string; init: RequestInit }>) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond(String(input), init ?? {});
  }) as typeof fetch;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the reset token is read only from an exact, well-formed token parameter", () => {
  assert.equal(resetTokenFromSearch(`token=${TOKEN}`), TOKEN);
  assert.equal(resetTokenFromSearch(`?token=${TOKEN}`), TOKEN);
  assert.equal(resetTokenFromSearch(""), null);
  assert.equal(resetTokenFromSearch("token=short"), null);
  assert.equal(resetTokenFromSearch(`token=${TOKEN}x`), null);
  assert.equal(resetTokenFromSearch(`token=${TOKEN}&token=${TOKEN}`), null);
});

test("request and confirm post JSON mutation headers and accept only { status: ok }", async () => {
  await withFetch(() => json(200, { status: "ok" }), async (calls) => {
    await requestPasswordReset("  owner@example.net ");
    await confirmPasswordReset(TOKEN, GOOD);
    assert.equal(calls[0]!.url, "/api/auth/password-reset/request");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { email: "owner@example.net" });
    assert.equal(calls[1]!.url, "/api/auth/password-reset/confirm");
    assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { token: TOKEN, password: GOOD });
    for (const call of calls) {
      assert.equal(call.init.method, "POST");
      assert.deepEqual(call.init.headers, { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" });
    }
  });
  assert.throws(() => parseOk({ status: "ok", token: TOKEN }), PasswordResetApiError);
  assert.throws(() => parseOk({ status: "done" }), PasswordResetApiError);
});

test("server and transport failures surface their error code", async () => {
  await withFetch(() => json(400, { error: { code: "invalid_token" } }), async () => {
    await assert.rejects(confirmPasswordReset(TOKEN, GOOD), (error: unknown) =>
      error instanceof PasswordResetApiError && error.code === "invalid_token" && error.status === 400);
  });
  await withFetch(() => json(429, { error: { code: "rate_limited" } }), async () => {
    await assert.rejects(requestPasswordReset("owner@example.net"), (error: unknown) =>
      error instanceof PasswordResetApiError && error.code === "rate_limited");
  });
  await withFetch(() => { throw new TypeError("offline"); }, async () => {
    await assert.rejects(requestPasswordReset("owner@example.net"), (error: unknown) =>
      error instanceof PasswordResetApiError && error.code === "network_error");
  });
});

test("email and new-password validation match the register policy", () => {
  assert.equal(validateResetEmail("owner@example.net"), null);
  assert.equal(validateResetEmail(" "), "请输入邮箱。");
  assert.equal(validateResetEmail("no-at-sign"), "请输入有效的邮箱地址。");
  assert.deepEqual(validateResetPassword(GOOD, GOOD, POLICY), {});
  assert.deepEqual(validateResetPassword("", "", POLICY), { password: "请设置新密码。", confirmPassword: "请再次输入新密码。" });
  assert.equal(validateResetPassword("x".repeat(11), "x".repeat(11), POLICY).password, "新密码至少需要 12 个字符。");
  assert.equal(validateResetPassword("x".repeat(257), "x".repeat(257), POLICY).password, "新密码不能超过 256 个字符。");
  assert.equal(validateResetPassword(GOOD, `${GOOD}!`, POLICY).confirmPassword, "两次输入的新密码不一致。");
});

test("error codes map to the token-expired state, a field message or a generic form message", () => {
  assert.deepEqual(resetConfirmFailure("invalid_token", POLICY), { kind: "invalid_token" });
  assert.equal(resetConfirmFailure("password_policy_violation", POLICY).kind, "field");
  assert.equal(resetConfirmFailure("rate_limited", POLICY).kind, "form");
  assert.equal(resetConfirmFailure("something_else", POLICY).kind, "form");
  assert.equal(resetRequestErrorMessage("rate_limited"), "请求过于频繁，请稍后再试。");
  assert.equal(resetRequestErrorMessage("whatever"), "暂时无法发送重置邮件，请稍后重试。");
});

test("routes are registered before the section catch-all and login links to the flow", () => {
  const app = source("../src/App.tsx");
  const section = app.indexOf('<Route path="/:section"');
  for (const path of ["/forgot-password", "/reset-password"]) {
    const index = app.indexOf(`<Route path="${path}"`);
    assert.ok(index > 0 && index < section, path);
  }
  const login = source("../app/components/auth/LoginPage.tsx");
  assert.match(login, /to="\/forgot-password"/);
  assert.doesNotMatch(login, /忘记密码（待接入）/);
});

test("the forgot page always shows the same sent notice and the reset page covers every state", () => {
  const forgot = source("../app/components/auth/ForgotPasswordPage.tsx");
  assert.match(forgot, /RESET_REQUEST_SENT_NOTICE/);
  assert.equal(RESET_REQUEST_SENT_NOTICE, "如果该邮箱已注册，我们已发送重置链接，请查收邮件");
  assert.doesNotMatch(forgot, /email_not_found|未注册/);

  const reset = source("../app/components/auth/ResetPasswordPage.tsx");
  assert.equal(RESET_DONE_NOTICE, "密码已重置，请使用新密码登录");
  assert.match(reset, /RESET_DONE_NOTICE/);
  assert.match(reset, /to="\/login"/);
  assert.match(reset, /to="\/forgot-password">重新申请/);
  assert.match(reset, /token === null \? "invalid" : "idle"/);
  // The token never reaches storage and is stripped from the address bar.
  assert.doesNotMatch(reset, /localStorage|sessionStorage|document\.cookie/);
  assert.match(reset, /navigate\("\/reset-password", \{ replace: true \}\)/);
});
