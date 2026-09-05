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

test("the shared auth shell provides an exact internal return-home link", () => {
  const shell = source("../app/components/auth/AuthShell.tsx");
  const login = source("../app/components/auth/LoginPage.tsx");
  const register = source("../app/components/auth/RegisterPage.tsx");

  assert.match(shell, /<Link className="auth-brand" to="\/" aria-label="返回首页">/);
  assert.match(shell, /<span className="auth-home-label">返回首页<\/span>/);
  assert.match(login, /<AuthShell /);
  assert.match(register, /<AuthShell /);
});
