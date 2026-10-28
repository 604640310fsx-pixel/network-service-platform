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
  validateRegistrationStart,
  validateRegistrationSubmission,
  type RegistrationStage,
} from "../app/components/auth/registrationFlow.ts";
import { canonicalInviteCode } from "../app/lib/registration-api.ts";
import { en } from "../app/i18n/en.ts";
import { zh } from "../app/i18n/zh.ts";

const POLICY = { minLength: REGISTRATION_PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH };
const GOOD = "correct-horse-12";
const TOKEN_A = `v1.${"a".repeat(43)}`;
const TOKEN_B = `v1.${"b".repeat(43)}`;
const STAGES: readonly RegistrationStage[] = ["start", "resend", "verify", "complete"];
// Synthetic local-only codes (not real invites).
const PERSONAL = "aB3_dE6-gH9jK2mN5pQ8rS1t";
const LEGACY = "ABCD-EFGH-JKMN-PQRS-TVWX-YZ23-4567";
// Same shapes as the auth-service start schema (personal 24 or legacy 7x4).
const SERVER_INVITE = /^(?:[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}|[A-Za-z0-9_-]{24})$/;

function start(email: string, inviteCode: string, messages = zh.register.validation) {
  return validateRegistrationStart({ email, inviteCode }, messages);
}

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
  // Scoped to the submit handler: the send handler has its own early return.
  const register = source("../app/components/auth/RegisterPage.tsx").split("async function handleSubmit(")[1];
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
  assert.match(failed, /showFailure\(result\.error, result\.phase === "awaiting_verification" \? "verify" : "complete"\)/);
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

test("only an explicit email_taken error at completion names the email as registered", () => {
  assert.deepEqual(registrationErrorNotice("email_taken", "complete", zh.register.errors), {
    text: "该邮箱已注册，请直接登录。",
    loginLink: true,
    recovery: "none",
  });
  for (const stage of STAGES) {
    for (const code of [null, "invalid_request", "invalid_or_expired", "request_failed", "invalid_response", "network_error", "anything_else"]) {
      const notice = registrationErrorNotice(code, stage, zh.register.errors);
      assert.equal(notice.loginLink, false, `${stage}:${code}`);
      assert.doesNotMatch(notice.text, /已注册|已存在|邀请码/, `${stage}:${code}`);
    }
    // The server only returns email_taken at completion; elsewhere it stays generic.
    if (stage !== "complete") {
      assert.deepEqual(registrationErrorNotice("email_taken", stage, zh.register.errors), {
        text: zh.register.errors.generic,
        loginLink: false,
        recovery: "none",
      });
    }
  }
  assert.equal(registrationErrorNotice(null, "start", zh.register.errors).text, "暂时无法完成注册，请稍后重试。");
  assert.equal(registrationErrorNotice("request_failed", "start", zh.register.errors).text, "暂时无法完成注册，请稍后重试。");
});

test("registration copy never claims a specific account or invite failure elsewhere", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");
  const flow = source("../app/components/auth/registrationFlow.ts");
  assert.doesNotMatch(register, /邮箱已注册|账号已存在|邀请码无效|邀请码已使用|邀请码已撤销|邀请码已过期|邀请码已耗尽/);
  const dictionary = source("../app/i18n/zh.ts");
  assert.equal(dictionary.match(/该邮箱已注册，请直接登录。/g)?.length, 1);
  assert.match(
    flow,
    /case "email_taken":\s*return stage === "complete"\s*\? \{ text: messages\.emailTaken, loginLink: true, recovery: "none" \}\s*: notice\(messages\.generic\);/,
  );
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

test("send-code validation checks only email and invite, with distinct empty and format messages", () => {
  const v = zh.register.validation;
  assert.deepEqual(start("invitee@example.test", PERSONAL), {});
  assert.deepEqual(start("", ""), { email: v.emailRequired, inviteCode: v.inviteRequired });
  assert.deepEqual(start("   ", "  "), { email: v.emailRequired, inviteCode: v.inviteRequired });
  // Only email and invite are inputs: a send never needs a password or code.
  assert.deepEqual(Object.keys(start("invitee@example.test", "")), ["inviteCode"]);
  assert.deepEqual(Object.keys(start("", PERSONAL)), ["email"]);
});

test("email format mirrors the server: ASCII only, complete address", () => {
  const v = zh.register.validation;
  for (const email of ["  Invitee@Example.TEST  ", "a.b+tag@sub.example.test"]) {
    assert.equal(start(email, PERSONAL).email, undefined, email);
  }
  for (const email of ["测试@example.test", "invitee＠example.test", "in vitee@example.test", "invitee​@example.test", "invitee@exämple.test"]) {
    assert.equal(start(email, PERSONAL).email, v.emailCharacters, email);
  }
  for (const email of ["invitee", "invitee@", "invitee@example", "@example.test", "invitee@@example.test", `${"a".repeat(250)}@x.test`]) {
    assert.equal(start(email, PERSONAL).email, v.emailFormat, email);
  }
});

test("personal invite codes are 24 characters and case-preserving; both legacy cases are accepted", () => {
  const v = zh.register.validation;
  assert.equal(start("invitee@example.test", PERSONAL).inviteCode, undefined);
  assert.equal(start("invitee@example.test", ` ${PERSONAL} `).inviteCode, undefined);
  assert.equal(start("invitee@example.test", LEGACY).inviteCode, undefined);
  assert.equal(start("invitee@example.test", LEGACY.toLowerCase()).inviteCode, undefined);
  // 23 and 25 characters are rejected with the actual length, never padded or trimmed to fit.
  assert.equal(start("invitee@example.test", PERSONAL.slice(0, 23)).inviteCode, v.inviteLength(23));
  assert.equal(start("invitee@example.test", `${PERSONAL}x`).inviteCode, v.inviteLength(25));
  assert.match(v.inviteLength(23), /当前 23 位/);
  // Every accepted value is sent in a server-accepted shape; personal codes unchanged.
  for (const value of [PERSONAL, ` ${PERSONAL} `, LEGACY, LEGACY.toLowerCase()]) {
    assert.equal(start("invitee@example.test", value).inviteCode, undefined, value);
    assert.match(canonicalInviteCode(value), SERVER_INVITE, value);
  }
  assert.equal(canonicalInviteCode(PERSONAL), PERSONAL);
});

test("malformed invite input gets format guidance without extraction or status claims", () => {
  const v = zh.register.validation;
  const link = `https://www.example.test/register?invite=${PERSONAL}`;
  for (const value of [link, `/register?invite=${PERSONAL}`, `invite=${PERSONAL}`]) {
    assert.equal(start("invitee@example.test", value).inviteCode, v.inviteLink, value);
  }
  for (const value of ["aB3_dE6 gH9jK2mN5pQ8rS1t", "aB3_dE6-gH9jK2mN5pQ8rS1！", `${PERSONAL.slice(0, 23)}​`]) {
    assert.equal(start("invitee@example.test", value).inviteCode, v.inviteCharacters, value);
  }
  // Legacy shape but with letters the legacy alphabet never uses (I, L, O, U).
  assert.equal(start("invitee@example.test", "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23").inviteCode, v.inviteLegacyCharacters);
  for (const text of Object.values(v).map((entry) => (typeof entry === "function" ? entry(23) : entry))) {
    assert.doesNotMatch(text, /邀请码无效|已使用|已过期|已撤销|不存在|已注册/);
  }
});

test("server error codes map by the stage that actually failed", () => {
  const e = zh.register.errors;
  const map = (code: string | null, stage: RegistrationStage) => registrationErrorNotice(code, stage, e);
  for (const stage of STAGES) {
    assert.deepEqual(map("network_error", stage), { text: e.network, loginLink: false, recovery: "none" });
    assert.equal(map("auth_unavailable", stage).text, e.unavailable);
    assert.equal(map("busy", stage).text, e.busy);
    assert.equal(map("origin_rejected", stage).text, e.originRejected);
    // invalid_request after local checks passed: request rejected, not "your invite is invalid".
    assert.deepEqual(map("invalid_request", stage), { text: e.invalidRequest, loginLink: false, recovery: "none" });
    for (const code of [null, "request_failed", "invalid_response", "some_new_code"]) {
      assert.deepEqual(map(code, stage), { text: e.generic, loginLink: false, recovery: "none" }, `${stage}:${code}`);
    }
  }
  assert.equal(map("rate_limited", "start").text, e.rateLimitedSend);
  assert.equal(map("rate_limited", "resend").text, e.rateLimitedSend);
  assert.equal(map("rate_limited", "verify").text, e.rateLimited);
  assert.equal(map("rate_limited", "complete").text, e.rateLimited);
  // The combined invalid_or_expired code: at verify the token may still be usable.
  assert.deepEqual(map("invalid_or_expired", "verify"), { text: e.codeInvalidOrExpired, loginLink: false, recovery: "restart" });
  assert.match(e.codeInvalidOrExpired, /不正确或已失效/);
  for (const stage of ["start", "resend", "complete"] as const) {
    assert.deepEqual(map("invalid_or_expired", stage), { text: e.sessionExpired, loginLink: false, recovery: "reset" });
  }
  assert.match(e.sessionExpired, /无效或已过期/);
  assert.equal(map("password_policy_violation", "complete").text, e.passwordPolicy);
  assert.equal(map("password_policy_violation", "verify").text, e.generic);
  // Never echo a server-provided code or text.
  assert.doesNotMatch(map("some_new_code", "start").text, /some_new_code/);
});

test("Chinese and English carry the same registration validation and error keys", () => {
  for (const group of ["validation", "errors"] as const) {
    assert.deepEqual(Object.keys(en.register[group]).sort(), Object.keys(zh.register[group]).sort(), group);
    for (const [key, value] of Object.entries(en.register[group])) {
      const text = typeof value === "function" ? (value as (n: number) => string)(23) : value;
      assert.ok(text.length > 0 && !/[㐀-鿿]/.test(text), key);
    }
  }
  assert.equal(start("", "", en.register.validation).email, "Enter your email.");
  assert.match(en.register.validation.inviteLength(23), /\(23 characters\)/);
  assert.ok(en.register.restart.length > 0 && zh.register.restart.length > 0);
});

test("the register page validates the send locally before any start request", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");
  const send = register.slice(register.indexOf("async function handleSendCode()"), register.indexOf("async function handleSubmit("));
  const validation = send.indexOf("validateRegistrationStart(");
  const earlyReturn = send.indexOf("if (hasFieldErrors(errors)) {");
  const request = send.indexOf("await startRegistration(");
  assert.ok(validation > 0 && validation < earlyReturn && earlyReturn < request);
  // A send never reads the password or code, and a synchronous guard blocks duplicates.
  assert.doesNotMatch(send, /password|verificationCode,/);
  assert.match(send, /inFlight\.current \|\|/);
  assert.match(send, /inFlight\.current = true;[\s\S]*finally \{\s*inFlight\.current = false;/);
  // Neutral 200 keeps conditional wording; no delivery claim.
  assert.match(send, /setNotice\(\{ tone: "neutral", text: t\.register\.codeSent \}\)/);
  assert.doesNotMatch(zh.register.codeSent, /已发送|已送达|已投递/);
  // Fields are associated with their error text.
  assert.match(register, /aria-invalid=\{fieldErrors\.email !== undefined\}/);
  assert.match(register, /aria-invalid=\{fieldErrors\.inviteCode !== undefined\}/);
  assert.match(register, /id=\{emailErrorId\} aria-live="polite"/);
  assert.match(register, /id=\{inviteErrorId\} aria-live="polite"/);
});
