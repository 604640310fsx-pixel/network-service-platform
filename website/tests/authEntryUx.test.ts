import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

// Interface copy lives in the i18n dictionaries; components reference it by key.
const zhCopy = source("../app/i18n/zh.ts");

test("login and protected routes expose a live session-checking status", () => {
  const app = source("../src/App.tsx");
  const shell = source("../app/components/auth/AuthShell.tsx");

  assert.equal(
    app.match(/if \(status === "checking"\) return <AuthSessionChecking \/>;/g)?.length,
    2,
  );
  assert.ok(app.indexOf('section === "subscribe" || section === "monitor"') < app.lastIndexOf('status === "checking"'));
  assert.match(shell, /role="status"/);
  assert.match(shell, /aria-live="polite"/);
  assert.match(shell, /aria-busy="true"/);
  assert.match(shell, /\{t\.authShell\.checkingSession\}/);
  assert.match(zhCopy, /checkingSession: "正在确认登录状态…"/);
});

test("a valid login retry clears the previous server error before its request", () => {
  const login = source("../app/components/auth/LoginPage.tsx");
  const clearError = login.indexOf("setError(null);");
  const beginRequest = login.indexOf('setStatus("submitting");');
  const request = login.indexOf("await login(email, password);");

  assert.ok(clearError > login.indexOf("setError(t.login.fillBoth)"));
  assert.match(zhCopy, /fillBoth: "请填写邮箱与密码。"/);
  assert.ok(clearError < beginRequest);
  assert.ok(beginRequest < request);
  assert.match(login, /disabled=\{submitting\}/);
  assert.match(login, /if \(submitting\) return;/);
});

test("a verified registration locks the code while keeping completion retryable", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");

  const flow = source("../app/components/auth/registrationFlow.ts");

  assert.match(register, /disabled=\{busy \|\| phase !== "awaiting_verification"\}/);
  // The verify-then-complete order and the retained verified state live in
  // registrationFlow.ts (behaviour covered by registrationFlow.test.ts).
  assert.match(flow, /if \(phase === "awaiting_verification"\) \{[\s\S]*?requests\.verify\([\s\S]*?phase = "verified";[\s\S]*?\}[\s\S]*?await requests\.complete\(/);
  assert.match(register, /setRegistrationToken\(result\.registrationToken\);\s*setPhase\(result\.phase\);/);
  assert.match(register, /name="password"[\s\S]*?disabled=\{busy \|\| completed\}/);
  assert.match(register, /name="confirmPassword"[\s\S]*?disabled=\{busy \|\| completed\}/);
});

test("registration copy keeps invite state indistinguishable until completion", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");
  const flow = source("../app/components/auth/registrationFlow.ts");

  assert.match(register, /setNotice\(\{ tone: "neutral", text: t\.register\.codeSent \}\)/);
  assert.match(
    zhCopy,
    /codeSent: "如果邀请码有效且可用于该邮箱，验证码将发送到该邮箱，请注意查收。"/,
  );
  // invalid_or_expired is one combined server code: the copy keeps both readings.
  assert.match(zhCopy, /codeInvalidOrExpired: "验证码不正确或已失效。/);
  assert.match(zhCopy, /sessionExpired: "注册状态无效或已过期，/);
  assert.match(
    flow,
    /case "invalid_or_expired":\s*if \(stage === "verify"\) return notice\(messages\.codeInvalidOrExpired, "restart"\);\s*return notice\(messages\.sessionExpired, "reset"\);/,
  );
  for (const text of [register, flow, zhCopy]) {
    assert.doesNotMatch(text, /邀请码已撤销|邀请码已过期|邀请码已耗尽/);
  }
});

test("registration copy states invite-only policy without promising success", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");

  // One concise invite sentence replaces the earlier repeated subtitle and notice.
  assert.match(register, /subtitle=\{t\.register\.subtitle\}/);
  assert.equal(zhCopy.match(/请输入邀请码完成注册。/g)?.length, 1);
  assert.doesNotMatch(zhCopy, /当前仅开放邀请注册：|个人邀请码只用于注册，不能登录任何账户|仅限邀请注册，需使用管理员签发的邀请码/);
  // Personal codes are case-sensitive: never uppercase while typing, only legacy codes at submit.
  assert.match(register, /canonicalInvite = canonicalInviteCode\(inviteCode\);/);
  assert.match(register, /onChange=\{\(event\) => \{\s*setInviteCode\(event\.target\.value\);/);
  assert.doesNotMatch(register, /setInviteCode\(event\.target\.value\.toUpperCase\(\)\)/);
  assert.doesNotMatch(zhCopy, /注册暂未开放|注册暂不可用/);
  assert.doesNotMatch(zhCopy, /创建账号后进入服务管理页面|开放注册|自助注册/);
  assert.doesNotMatch(zhCopy, /获取邀请码|申请邀请码|即将开放|预计开放/);
});

test("the shared auth shell provides an exact internal return-home link", () => {
  const shell = source("../app/components/auth/AuthShell.tsx");
  const login = source("../app/components/auth/LoginPage.tsx");
  const register = source("../app/components/auth/RegisterPage.tsx");

  assert.match(shell, /<Link className="auth-brand" to="\/" aria-label=\{t\.authShell\.backHome\}>/);
  assert.match(shell, /<span className="auth-home-label">\{t\.authShell\.backHome\}<\/span>/);
  assert.match(zhCopy, /backHome: "返回首页"/);
  assert.match(login, /<AuthShell /);
  assert.match(register, /<AuthShell /);
});
