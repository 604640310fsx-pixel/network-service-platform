import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

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
  assert.match(shell, /正在确认登录状态…/);
});

test("a valid login retry clears the previous server error before its request", () => {
  const login = source("../app/components/auth/LoginPage.tsx");
  const clearError = login.indexOf("setError(null);");
  const beginRequest = login.indexOf('setStatus("submitting");');
  const request = login.indexOf("await login(email, password);");

  assert.ok(clearError > login.indexOf('setError("请填写邮箱与密码。")'));
  assert.ok(clearError < beginRequest);
  assert.ok(beginRequest < request);
  assert.match(login, /disabled=\{submitting\}/);
  assert.match(login, /if \(submitting\) return;/);
});

test("a verified registration locks the code while keeping completion retryable", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");

  assert.match(register, /disabled=\{busy \|\| phase !== "awaiting_verification"\}/);
  assert.match(register, /if \(phase === "awaiting_verification"\) \{[\s\S]*?verifyRegistrationCode\([\s\S]*?setRegistrationToken\(currentToken\);[\s\S]*?setPhase\("verified"\);[\s\S]*?\}/);
  assert.match(register, /setPhase\("verified"\);[\s\S]*?await completeRegistration\(/);
  assert.match(register, /name="password"[\s\S]*?disabled=\{busy \|\| completed\}/);
  assert.match(register, /name="confirmPassword"[\s\S]*?disabled=\{busy \|\| completed\}/);
});

test("registration copy keeps invite state indistinguishable until completion", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");

  assert.match(
    register,
    /如果邮箱与邀请码匹配，验证码将发送到该邮箱，请注意查收。/,
  );
  assert.match(register, /注册信息无效或已过期，请重新开始。/);
  assert.doesNotMatch(register, /邀请码已撤销|邀请码已过期|邀请码已耗尽/);
});

test("registration copy states invite-only policy without promising success", () => {
  const register = source("../app/components/auth/RegisterPage.tsx");

  assert.match(register, /注册暂未开放。/);
  assert.match(register, /邀请码由管理员签发、绑定指定邮箱且仅可使用一次/);
  assert.match(register, /持有邀请码不代表当前可以完成注册/);
  assert.doesNotMatch(register, /创建账号后进入服务管理页面/);
  assert.doesNotMatch(register, /获取邀请码|申请邀请码|即将开放|预计开放/);
});

test("the shared auth shell provides an exact internal return-home link", () => {
  const shell = source("../app/components/auth/AuthShell.tsx");
  const login = source("../app/components/auth/LoginPage.tsx");
  const register = source("../app/components/auth/RegisterPage.tsx");

  assert.match(shell, /<Link className="auth-brand" to="\/" aria-label="返回首页">/);
  assert.match(shell, /<span className="auth-home-label">返回首页<\/span>/);
  assert.match(login, /<AuthShell /);
  assert.match(register, /<AuthShell /);
});
