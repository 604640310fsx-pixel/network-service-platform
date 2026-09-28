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
