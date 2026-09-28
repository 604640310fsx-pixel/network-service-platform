import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("new orders can only be submitted by a confirmed signed-in customer", () => {
  const form = source("../app/components/subscribe/RequirementForm.tsx");

  assert.match(form, /const \{ status: authStatus \} = useAuth\(\);/);
  assert.match(form, /const signedIn = authStatus === "authenticated";/);
  assert.match(form, /const canSubmit =\s*signedIn && /);
  assert.match(form, /if \(!signedIn \|\| submitting/);
});

test("retry of an existing order requires login and keeps holders on the same order page", () => {
  const panel = source("../app/components/subscribe/OrderStatusPanel.tsx");

  // 未登录时在生成任何重试凭证之前返回。
  const guard = panel.indexOf('if (authStatus !== "authenticated") {\n      setActionError(RETRY_LOGIN_REQUIRED);\n      return;');
  assert.ok(guard > 0);
  assert.ok(guard < panel.indexOf("credentials = getOrCreateRetryAttempt(orderRef);"));
  // 401 在清理凭证分支之前返回，保留本次重试凭证。
  const unauthorized = panel.indexOf('retryError.code === "unauthorized"');
  assert.ok(unauthorized > 0);
  assert.ok(unauthorized < panel.indexOf("shouldClearAttemptAfterError(retryError)"));
  assert.match(panel, /登录后请在本浏览器重新打开本订单页面，再点击“重新支付”。/);
  assert.match(
    panel,
    /\{snapshot\.status === "closed" && authStatus === "unauthenticated" && \([\s\S]*?需先<Link to="\/login">登录<\/Link>；登录后请在本浏览器重新打开本订单页面/,
  );
  // 不引导旧订单持有人放弃重试、改选新套餐。
  assert.doesNotMatch(panel, /重新支付[^"\n]*重新选择套餐/);
});

test("signed-out visitors get the existing login entry and honest reselect guidance", () => {
  const form = source("../app/components/subscribe/RequirementForm.tsx");

  assert.match(
    form,
    /\{authStatus === "unauthenticated" && \(\s*<p>\s*下单需先<Link to="\/login">登录<\/Link>；登录后需返回“套餐订阅”重新选择套餐。/,
  );
  assert.ok(form.indexOf("下单需先<Link") < form.indexOf('<button type="submit"'));
  assert.match(form, /case "unauthorized":\s*return "登录状态已失效，请重新登录后返回“套餐订阅”重新选择套餐。";/);
  // 登录入口不保留所选套餐，也不再提示游客下单。
  assert.doesNotMatch(form, /保留(所选|已选)?(方案|套餐)|自动返回|未登录下单|已登录用户也可/);
});
