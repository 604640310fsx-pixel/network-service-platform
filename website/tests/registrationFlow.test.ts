import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PASSWORD_MAX_LENGTH,
  REGISTRATION_PASSWORD_MIN_LENGTH,
} from "../app/components/auth/passwordPolicy.ts";
import {
  hasFieldErrors,
  registrationErrorNotice,
  REGISTRATION_SUCCESS_NAVIGATION,
  registrationCompleteFromLocationState,
  runRegistrationSubmission,
  validateRegistrationSubmission,
} from "../app/components/auth/registrationFlow.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };
const GOOD = "correct-horse-12";
const TOKEN_A = `v1.${"a".repeat(43)}`;
const TOKEN_B = `v1.${"b".repeat(43)}`;

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function validate(overrides: Partial<Parameters<typeof validateRegistrationSubmission>[0]>) {
  return validateRegistrationSubmission(
    {
      phase: "awaiting_verification",
      verificationCode: "123456",
      password: GOOD,
      confirmPassword: GOOD,
      ...overrides,
    },
    POLICY,
    zh.register.validation,
  );
}

function recorder(outcomes: { verify?: () => Promise<string>; complete?: () => Promise<void> }) {
  const calls: string[] = [];
  return {
    calls,
    requests: {
      verify: async (token: string, otp: string) => {
        calls.push(`verify:${token}:${otp}`);
        return outcomes.verify ? outcomes.verify() : TOKEN_B;
      },
      complete: async (token: string) => {
        calls.push(`complete:${token}`);
        if (outcomes.complete) await outcomes.complete();
      },
    },
  };
}

test("valid input produces no field errors", () => {
  assert.deepEqual(validate({}), {});
  assert.equal(hasFieldErrors(validate({})), false);
  assert.deepEqual(validate({ verificationCode: " 123456 " }), {});
});

test("verification code must be exactly six digits while awaiting verification", () => {
  assert.equal(validate({ verificationCode: "" }).verificationCode, "请输入邮箱验证码。");
  for (const code of ["12345", "1234567", "12a456", "１２３４５６", "12 456"]) {
    assert.equal(validate({ verificationCode: code }).verificationCode, "验证码应为 6 位数字。", code);
  }
  // Once verified the code field is locked and no longer validated.
  assert.equal(validate({ phase: "verified", verificationCode: "" }).verificationCode, undefined);
});

test("password length follows the existing 12-256 policy", () => {
  const short = "x".repeat(REGISTRATION_PASSWORD_MIN_LENGTH - 1);
  const long = "x".repeat(PASSWORD_MAX_LENGTH + 1);
  assert.equal(validate({ password: "", confirmPassword: "" }).password, "请设置密码。");
  assert.equal(validate({ password: short, confirmPassword: short }).password, "密码至少需要 12 个字符。");
  assert.equal(validate({ password: long, confirmPassword: long }).password, "密码不能超过 256 个字符。");
  const edge = "x".repeat(REGISTRATION_PASSWORD_MIN_LENGTH);
  assert.equal(validate({ password: edge, confirmPassword: edge }).password, undefined);
  const max = "x".repeat(PASSWORD_MAX_LENGTH);
  assert.equal(validate({ password: max, confirmPassword: max }).password, undefined);
});

test("password confirmation must be present and match", () => {
  assert.equal(validate({ confirmPassword: "" }).confirmPassword, "请再次输入密码。");
  assert.equal(validate({ confirmPassword: `${GOOD}x` }).confirmPassword, "两次输入的密码不一致。");
});

test("a failed verification stays on registration with the original token", async () => {
  const failure = new Error("server");
  const { calls, requests } = recorder({ verify: () => Promise.reject(failure) });
  const result = await runRegistrationSubmission(
    { phase: "awaiting_verification", registrationToken: TOKEN_A, verificationCode: " 123456 ", password: GOOD, confirmPassword: GOOD },
    requests,
  );
  assert.deepEqual(result, { kind: "failed", error: failure, phase: "awaiting_verification", registrationToken: TOKEN_A });
  assert.deepEqual(calls, [`verify:${TOKEN_A}:123456`]);
});

test("a failed completion after verification keeps the verified state for retry", async () => {
  const failure = new Error("server");
  const first = recorder({ complete: () => Promise.reject(failure) });
  const result = await runRegistrationSubmission(
    { phase: "awaiting_verification", registrationToken: TOKEN_A, verificationCode: "123456", password: GOOD, confirmPassword: GOOD },
    first.requests,
  );
  assert.deepEqual(result, { kind: "failed", error: failure, phase: "verified", registrationToken: TOKEN_B });
  assert.deepEqual(first.calls, [`verify:${TOKEN_A}:123456`, `complete:${TOKEN_B}`]);

  // The retry from the verified state never re-sends the code.
  const retry = recorder({});
  const retried = await runRegistrationSubmission(
    { phase: "verified", registrationToken: TOKEN_B, verificationCode: "", password: GOOD, confirmPassword: GOOD },
    retry.requests,
  );
  assert.deepEqual(retried, { kind: "completed" });
  assert.deepEqual(retry.calls, [`complete:${TOKEN_B}`]);
});

test("successful completion navigates to /login replacing history with no secrets", async () => {
  const { requests } = recorder({});
  const result = await runRegistrationSubmission(
    { phase: "awaiting_verification", registrationToken: TOKEN_A, verificationCode: "123456", password: GOOD, confirmPassword: GOOD },
    requests,
  );
  assert.deepEqual(result, { kind: "completed" });
  assert.equal(REGISTRATION_SUCCESS_NAVIGATION.to, "/login");
  assert.deepEqual(REGISTRATION_SUCCESS_NAVIGATION.options, { replace: true, state: { registrationComplete: true } });
  assert.equal(zh.login.registeredNotice, "注册成功，请登录");
});

test("the login notice only accepts the exact non-sensitive success flag", () => {
  assert.equal(registrationCompleteFromLocationState({ registrationComplete: true }), true);
  for (const state of [
    null,
    undefined,
    "registrationComplete",
    { registrationComplete: "true" },
    { registrationComplete: true, email: "a@example.net" },
    [true],
  ]) {
    assert.equal(registrationCompleteFromLocationState(state), false);
  }
});

test("the register page validates before requests and navigates only after completion", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");
  const validation = register.indexOf("validateRegistrationSubmission(");
  const earlyReturn = register.indexOf("if (hasFieldErrors(errors)) {");
  const request = register.indexOf("await runRegistrationSubmission(");
  const failedBranch = register.indexOf('if (result.kind === "failed") {');
  const clear = register.indexOf('setPassword("");', failedBranch);
  const navigation = register.indexOf("navigate(REGISTRATION_SUCCESS_NAVIGATION.to, REGISTRATION_SUCCESS_NAVIGATION.options);");
  assert.ok(validation > 0 && validation < earlyReturn && earlyReturn < request);
  assert.ok(request < failedBranch && failedBranch < clear && clear < navigation);
  const failed = register.slice(failedBranch, register.indexOf("return;", failedBranch));
  assert.doesNotMatch(failed, /navigate\(/);
  assert.match(failed, /registrationErrorNoticeFor\(result\.error, t\.register\.errors\)/);
  assert.equal(register.match(/navigate\(/g)?.length, 1);
});

test("registration secrets never travel through URL, router state or storage", () => {
  for (const file of ["../app/components/auth/RegisterPage.tsx", "../app/components/auth/LoginPage.tsx", "../app/components/auth/registrationFlow.ts"]) {
    const text = source(file);
    assert.doesNotMatch(text, /localStorage|sessionStorage|indexedDB|document\.cookie/, file);
    assert.doesNotMatch(text, /[?&](password|otp|code|token|invite)=/i, file);
  }
  const login = source("../app/components/auth/LoginPage.tsx");
  assert.match(login, /navigate\(location\.pathname, \{ replace: true, state: null \}\)/);
  assert.match(login, /registrationCompleteFromLocationState\(location\.state\)/);
});

test("only an explicit email_taken error names the email as registered", () => {
  assert.deepEqual(registrationErrorNotice("email_taken", zh.register.errors), { text: "该邮箱已注册，请直接登录。", loginLink: true });
  for (const code of [null, "invalid_request", "invalid_or_expired", "request_failed", "invalid_response", "network_error", "anything_else"]) {
    const notice = registrationErrorNotice(code, zh.register.errors);
    assert.equal(notice.loginLink, false, String(code));
    assert.doesNotMatch(notice.text, /已注册|已存在|邀请码/, String(code));
  }
  assert.equal(registrationErrorNotice(null, zh.register.errors).text, "注册服务暂时不可用，请稍后重试。");
  assert.equal(registrationErrorNotice("request_failed", zh.register.errors).text, "暂时无法完成注册，请稍后重试。");
  assert.equal(registrationErrorNotice("invalid_or_expired", zh.register.errors).text, "注册信息无效或已过期，请重新开始。");
});

test("registration copy never claims a specific account or invite failure elsewhere", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");
  const flow = source("../app/components/auth/registrationFlow.ts");
  assert.doesNotMatch(register, /邮箱已注册|账号已存在|邀请码无效|邀请码已使用|邀请码已撤销|邀请码已过期|邀请码已耗尽/);
  const dictionary = source("../app/i18n/zh.ts");
  assert.equal(dictionary.match(/该邮箱已注册，请直接登录。/g)?.length, 1);
  assert.match(flow, /case "email_taken":\s*return \{ text: messages\.emailTaken, loginLink: true \};/);
  for (const text of [flow, dictionary]) {
    assert.doesNotMatch(text, /账号已存在|邀请码无效|邀请码已使用|邀请码已撤销|邀请码已过期|邀请码已耗尽/);
  }
  assert.match(register, /notice\.loginLink && <> <Link to="\/login">\{t\.common\.toLogin\}<\/Link><\/>/);
  // English keeps the same rule: only email_taken says the address is registered.
  for (const [key, text] of Object.entries(en.register.errors)) {
    if (key === "emailTaken") assert.match(text, /already registered/);
    else assert.doesNotMatch(text, /registered|exists|invite/i, key);
  }
});
